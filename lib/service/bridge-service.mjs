// Core orchestration for Antigravity–Codex Bridge MCP tools.
// Delegates Codex multi-transport routing to codex-router.mjs and diagnostics to bridge-doctor.mjs.
import crypto from 'node:crypto';
import { createLocalSocketChecker } from '../core/local-socket.mjs';
import { errorOutcome, failure, outcome, publicDelivery } from '../core/outcome.mjs';
import { formatPeerEnvelope } from '../core/peer-envelope.mjs';
import { listDeliveries, reserveDelivery, settleDelivery } from '../state/delivery-ledger.mjs';
import {
  isValidLocalAddress,
  listAntigravityHosts,
  registerAntigravityHost,
  registerCodexDesktopHost,
} from '../state/host-registry.mjs';
import { resolveStateDir } from '../state/state-dir.mjs';
import {
  getAntigravityConversation,
  listAntigravityConversations,
  probeAntigravityHost,
  resolveAgentapiCommand,
  sendToAntigravityConversation,
} from '../transports/antigravity-client.mjs';
import { resolveCodexExecutable } from '../transports/codex-binary.mjs';
import {
  listDaemonThreads,
  normalizeCodexThreadId,
  openDaemon,
  queueToCodexThread,
  sendToDaemonThread,
} from '../transports/codex-daemon.mjs';
import { listDesktopThreads, sendToDesktopThread } from '../transports/codex-desktop.mjs';
import { runBridgeDoctor } from './bridge-doctor.mjs';
import { detectHostApp, resolveAntigravityCaller, resolveCodexCaller } from './caller-identity.mjs';
import { dispatchMessageToCodex, listMergedCodexThreads } from './codex-router.mjs';

const MESSAGE_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;
const MAX_MESSAGE_BYTES = 65_536;

function validateMessageId(id) {
  if (id === undefined || id === null || id === '') return crypto.randomUUID();
  if (typeof id !== 'string' || !MESSAGE_ID_RE.test(id)) {
    throw failure('message_id must be 1–100 ASCII letters, digits, underscore, or hyphen.', 'invalid_argument');
  }
  return id;
}

function validateMessageText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw failure('message must be a non-empty string.', 'invalid_argument');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
    throw failure(`message exceeds ${MAX_MESSAGE_BYTES} UTF-8 bytes.`, 'message_too_long');
  }
  return text;
}

export function createBridgeService(overrides = {}) {
  const env = overrides.env ?? process.env;
  const stateDir = overrides.stateDir ?? resolveStateDir(env);
  const deps = {
    openDaemon,
    listDaemonThreads,
    sendToDaemonThread,
    queueToCodexThread,
    listDesktopThreads,
    sendToDesktopThread,
    probeAntigravityHost,
    listAntigravityConversations,
    getAntigravityConversation,
    sendToAntigravityConversation,
    resolveAgentapiCommand,
    resolveCodexExecutable,
    createLocalSocketChecker,
    ...overrides.deps,
  };

  async function refreshOwnRegistration(metadata = {}, signal) {
    const lsAddress = String(env.ANTIGRAVITY_LS_ADDRESS ?? '').trim();
    const csrfToken = String(env.ANTIGRAVITY_CSRF_TOKEN ?? '').trim();
    if (isValidLocalAddress(lsAddress) && csrfToken) {
      await registerAntigravityHost(
        stateDir,
        { lsAddress, csrfToken, agentapiBin: env.ANTIGRAVITY_AGENTAPI_EXE },
        { signal },
      ).catch(() => {});
    }
    const pipePath = env.CODEX_APP_TOOLS_PIPE_PATH;
    if (pipePath) {
      try {
        const caller = resolveCodexCaller({ metadata, env });
        await registerCodexDesktopHost(stateDir, { pipePath, contextThreadId: caller.id }, { signal }).catch(() => {});
      } catch {
        // Ignore if no thread id is available during startup registration.
      }
    }
  }

  async function getReachableAntigravityHosts(signal) {
    const candidates = [];
    const envAddr = String(env.ANTIGRAVITY_LS_ADDRESS ?? '').trim();
    const envToken = String(env.ANTIGRAVITY_CSRF_TOKEN ?? '').trim();
    if (isValidLocalAddress(envAddr) && envToken) {
      candidates.push({ lsAddress: envAddr, csrfToken: envToken, agentapiBin: env.ANTIGRAVITY_AGENTAPI_EXE });
    }
    for (const host of listAntigravityHosts(stateDir)) {
      if (!candidates.some(c => c.lsAddress === host.lsAddress)) candidates.push(host);
    }
    if (candidates.length === 0) return [];
    const checks = await Promise.all(
      candidates.map(async host => ((await deps.probeAntigravityHost(host, { signal })) ? host : null)),
    );
    return checks.filter(Boolean);
  }

  async function handleListAntigravityConversations(args = {}, { signal } = {}) {
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
    const hosts = await getReachableAntigravityHosts(signal);
    if (hosts.length === 0) {
      throw failure(
        'No reachable local Antigravity host is registered. Open Antigravity with the bridge plugin enabled and run a turn.',
        'route_unavailable',
      );
    }
    const warnings = [];
    const merged = new Map();
    for (const host of hosts) {
      try {
        const convs = await deps.listAntigravityConversations(host, {
          limit,
          includeArchived: Boolean(args.include_archived),
          includeSubagents: Boolean(args.include_subagents),
          signal,
        });
        for (const conv of convs) {
          if (!merged.has(conv.conversation_id)) merged.set(conv.conversation_id, conv);
        }
      } catch (error) {
        warnings.push(`${host.lsAddress}: ${error.message}`);
      }
    }
    const conversations = [...merged.values()]
      .sort((a, b) => String(b.update_time).localeCompare(String(a.update_time)))
      .slice(0, limit);
    if (conversations.length === 0 && warnings.length > 0) {
      throw failure(`Could not list Antigravity conversations. ${warnings.join(' | ')}`, 'route_unavailable');
    }
    return { conversations, warnings };
  }

  async function handleSendToCodex(args = {}, { metadata = {}, signal } = {}) {
    if (detectHostApp({ env, metadata }) === 'codex') {
      throw failure('send_to_codex is for Antigravity callers; use send_to_antigravity from Codex.', 'wrong_tool');
    }
    const threadId = normalizeCodexThreadId(args.thread_id);
    if (!threadId) throw failure('thread_id is required.', 'invalid_argument');
    const message = validateMessageText(args.message);
    const messageId = validateMessageId(args.message_id);
    const transport = args.transport ?? 'auto';
    if (!['auto', 'daemon', 'desktop', 'queue'].includes(transport)) {
      throw failure('transport must be one of auto, daemon, desktop, or queue.', 'invalid_argument');
    }
    const includeMessage = args.include_message !== false;
    const caller = resolveAntigravityCaller({ stateDir, toolName: 'send_to_codex', args, metadata, env, consume: true });
    const draft = { message_id: messageId, from: { app: 'antigravity', id: caller.id }, to: { app: 'codex', id: threadId }, message };

    const reserved = await reserveDelivery(stateDir, draft, { retryFailed: Boolean(args.retry_failed), signal });
    if (reserved.action === 'replay') {
      return {
        delivery: publicDelivery(reserved.record, { includeMessage }),
        outcome: reserved.outcome,
        summary: `Already submitted to Codex thread ${threadId} (message_id=${messageId}).`,
      };
    }

    const envelope = formatPeerEnvelope({ fromApp: 'antigravity', fromId: caller.id, messageId, body: message });
    try {
      const usedTransport = await dispatchMessageToCodex({
        stateDir,
        env,
        deps,
        threadId,
        envelope,
        messageId,
        transport,
        allowSteer: !args.wait_if_busy,
        signal,
      });
      const settled = await settleDelivery(stateDir, draft.from, messageId, { status: 'submitted', transport: usedTransport });
      return {
        delivery: publicDelivery(settled ?? { ...reserved.record, status: 'submitted', transport: usedTransport }, { includeMessage }),
        outcome: outcome('submitted'),
        summary: `Submitted to Codex thread ${threadId} via ${usedTransport}.`,
      };
    } catch (error) {
      const uncertain = Boolean(error?.deliveryUnknown);
      const settled = await settleDelivery(stateDir, draft.from, messageId, {
        status: uncertain ? 'uncertain' : 'failed',
        error: error.message,
        error_reason: uncertain ? 'delivery_unconfirmed' : error.reason || 'internal_error',
      }).catch(() => null);
      error.record = settled ?? reserved.record;
      error.outcome = errorOutcome(error);
      throw error;
    }
  }

  async function handleSendToAntigravity(args = {}, { metadata = {}, signal } = {}) {
    if (detectHostApp({ env, metadata }) === 'antigravity') {
      throw failure('send_to_antigravity is for Codex callers; use send_to_codex from Antigravity.', 'wrong_tool');
    }
    const conversationId = String(args.conversation_id ?? '').trim();
    if (!conversationId) throw failure('conversation_id is required.', 'invalid_argument');
    const message = validateMessageText(args.message);
    const messageId = validateMessageId(args.message_id);
    const includeMessage = args.include_message !== false;

    const caller = resolveCodexCaller({ metadata, env });
    await refreshOwnRegistration(metadata, signal);

    const hosts = await getReachableAntigravityHosts(signal);
    if (hosts.length === 0) {
      throw failure('No reachable local Antigravity host is registered. Open Antigravity with the bridge plugin enabled.', 'route_unavailable');
    }

    let targetHost = null;
    let targetConv = null;
    for (const host of hosts) {
      try {
        targetConv = await deps.getAntigravityConversation(host, conversationId, { signal });
        targetHost = host;
        break;
      } catch (error) {
        if (error?.reason === 'target_unavailable') continue;
        throw error;
      }
    }
    if (!targetHost || !targetConv) {
      throw failure(`Antigravity conversation ${conversationId} was not found on any reachable local host.`, 'target_unavailable');
    }
    if (targetConv.parent_conversation_id && !args.allow_subagent) {
      throw failure('The target Antigravity conversation is a subagent session. Send to its top-level main conversation instead.', 'target_unavailable');
    }
    if (targetConv.archived) {
      throw failure('The target Antigravity conversation is archived. Unarchive it before sending.', 'target_unavailable');
    }

    const draft = { message_id: messageId, from: { app: 'codex', id: caller.id }, to: { app: 'antigravity', id: conversationId }, message };
    const reserved = await reserveDelivery(stateDir, draft, { retryFailed: Boolean(args.retry_failed), signal });
    if (reserved.action === 'replay') {
      return {
        delivery: publicDelivery(reserved.record, { includeMessage }),
        outcome: reserved.outcome,
        summary: `Already submitted to Antigravity conversation ${conversationId} (message_id=${messageId}).`,
      };
    }

    const envelope = formatPeerEnvelope({ fromApp: 'codex', fromId: caller.id, messageId, body: message });
    try {
      await deps.sendToAntigravityConversation(targetHost, {
        conversationId,
        title: args.title || `Bridge message from Codex (${caller.id.slice(0, 8)})`,
        text: envelope,
        env,
        signal,
      });
      const settled = await settleDelivery(stateDir, draft.from, messageId, { status: 'submitted', transport: 'agentapi' });
      return {
        delivery: publicDelivery(settled ?? { ...reserved.record, status: 'submitted', transport: 'agentapi' }, { includeMessage }),
        outcome: outcome('submitted'),
        summary: `Submitted to Antigravity conversation ${conversationId} via agentapi.`,
      };
    } catch (error) {
      const uncertain = Boolean(error?.deliveryUnknown);
      const settled = await settleDelivery(stateDir, draft.from, messageId, {
        status: uncertain ? 'uncertain' : 'failed',
        error: error.message,
        error_reason: uncertain ? 'delivery_unconfirmed' : error.reason || 'internal_error',
      }).catch(() => null);
      error.record = settled ?? reserved.record;
      error.outcome = errorOutcome(error);
      throw error;
    }
  }

  async function handleListDeliveries(args = {}, { metadata = {} } = {}) {
    const hostApp = detectHostApp({ env, metadata });
    if (!hostApp) throw failure('Could not identify the calling application (antigravity or codex).', 'caller_unverified');
    const caller =
      hostApp === 'codex'
        ? resolveCodexCaller({ metadata, env })
        : resolveAntigravityCaller({ stateDir, toolName: 'list_deliveries', args, metadata, env, consume: true });
    const rows = listDeliveries(stateDir, caller, {
      messageId: args.message_id ? String(args.message_id).trim() : undefined,
      limit: Math.max(1, Math.min(Number(args.limit) || 20, 100)),
    });
    return {
      application: caller.app,
      sender_id: caller.id,
      deliveries: rows.map(row => publicDelivery(row, { includeMessage: true })),
    };
  }

  async function executeTool(name, args = {}, context = {}) {
    switch (name) {
      case 'list_codex_threads':
        return listMergedCodexThreads({ stateDir, env, deps, limit: args.limit, signal: context.signal });
      case 'list_antigravity_conversations':
        return handleListAntigravityConversations(args, context);
      case 'send_to_codex':
        return handleSendToCodex(args, context);
      case 'send_to_antigravity':
        return handleSendToAntigravity(args, context);
      case 'list_deliveries':
        return handleListDeliveries(args, context);
      case 'bridge_doctor':
        return runBridgeDoctor({
          stateDir,
          env,
          deps,
          args,
          metadata: context.metadata,
          signal: context.signal,
          refreshOwnRegistration,
          getReachableAntigravityHosts,
        });
      default:
        throw failure(`Unknown bridge tool: ${name}`, 'invalid_argument');
    }
  }

  return { stateDir, executeTool, refreshOwnRegistration };
}
