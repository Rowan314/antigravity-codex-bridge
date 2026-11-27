// A dispatch creates a target conversation and submits the first turn in one native write.
import { resolve } from 'node:path';
import { failure, markDeliveryUnknown, outcome, publicDelivery, unconfirmedReply } from '../core/outcome.mjs';
import { formatPeerEnvelope } from '../core/peer-envelope.mjs';
import { reserveDelivery, settleDelivery } from '../state/delivery-ledger.mjs';
import { listCodexDesktopHosts } from '../state/host-registry.mjs';
import { detectHostApp, resolveAntigravityCaller, resolveCodexCaller } from './caller-identity.mjs';

const MAX_MESSAGE_BYTES = 65_536;

function requiredText(args, key, max) {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw failure(`${key} must be a nonempty string of at most ${max} characters.`, 'invalid_argument');
  }
  return value;
}

async function readCodex(deps, env, id, signal) {
  const connection = await deps.openDaemon({ env, signal, timeoutMs: 4_000 });
  try {
    return await deps.readDaemonThread(connection, id, { signal, timeoutMs: 4_000 });
  } finally {
    connection.close();
  }
}

function isCodexMain(thread) {
  // Interactive Codex sources are represented by a string. Subagent
  // sources are structured objects in the Codex app-server protocol.
  return ['vscode', 'cli', 'appServer'].includes(thread?.source);
}

function isAntigravityMain(conversation) {
  return conversation && !conversation.archived && !conversation.parent_conversation_id;
}

async function verifyAntigravityCaller(hosts, caller, deps, signal) {
  for (const host of hosts) {
    try {
      const conversation = await deps.getAntigravityConversation(host, caller.id, { signal });
      if (isAntigravityMain(conversation)) return;
      break;
    } catch (error) {
      if (error?.reason !== 'target_unavailable') throw error;
    }
  }
  throw failure('Dispatch requires a verified Antigravity main conversation.', 'caller_unverified');
}

async function prepareAntigravity({ hosts, projectId, deps, env, signal }) {
  if (!hosts.length) throw failure('No reachable local Antigravity host is registered.', 'route_unavailable');
  const matches = [];
  for (const host of hosts) {
    const conversations = await deps.listAntigravityConversations(host, { limit: 50, projectId, signal });
    if (conversations.some(c => c.project_id === projectId && isAntigravityMain(c))) matches.push(host);
  }
  if (matches.length !== 1) {
    throw failure(
      matches.length ? 'The Antigravity project exists on multiple local hosts.' :
        'The Antigravity project could not be verified. Use a project ID from an existing main conversation.',
      'target_unavailable',
    );
  }
  const [host] = matches;
  const command = deps.resolveAgentapiCommand(host, env);
  if (!command) throw failure('Antigravity agentapi is unavailable.', 'setup_incomplete');
  return {
    create: options => deps.createAntigravityConversation(host, { ...options, projectId, command, env, signal }),
    verify: async id => {
      const conv = await deps.getAntigravityConversation(host, id, { signal });
      return isAntigravityMain(conv) && conv.project_id === projectId;
    },
  };
}

async function prepareCodex({ stateDir, projectId, deps, env, signal }) {
  let nativeError = null;
  // 1. Primary on macOS: official `codex://threads/new` deep link + Accessibility verification.
  if (deps.prepareCodexAppNativeDispatch && deps.createCodexAppNativeThread) {
    try {
      const prepared = await deps.prepareCodexAppNativeDispatch({ stateDir, projectId, env, signal });
      return {
        projectPath: prepared.project.path,
        create: options => deps.createCodexAppNativeThread(prepared, { ...options, signal, deps }),
        verify: async id => {
          const thread = await readCodex(deps, env, id, signal);
          return thread?.source === 'vscode' && !thread.ephemeral &&
            typeof thread.cwd === 'string' && !!thread.cwd &&
            resolve(thread.cwd) === resolve(prepared.project.path);
        },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      nativeError = error;
      // Preserve explicit project-not-found or permission blocks if no Desktop pipe exists.
    }
  }

  // 2. Fallback: native Codex Desktop app-tools pipe (when available and compatible).
  const hosts = listCodexDesktopHosts(stateDir);
  let pipeError = null;
  for (const host of hosts) {
    let prepared;
    try {
      prepared = await deps.prepareCodexDesktopDispatch(host, { projectId, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      pipeError = error;
      continue;
    }
    return {
      projectPath: prepared.project.path,
      create: options => deps.createCodexDesktopThread(prepared, { ...options, signal }),
      verify: async id => {
        const thread = await readCodex(deps, env, id, signal);
        return thread?.source === 'vscode' && !thread.ephemeral &&
          typeof thread.cwd === 'string' && !!thread.cwd &&
          resolve(thread.cwd) === resolve(prepared.project.path);
      },
    };
  }

  throw nativeError ?? pipeError ?? failure('No native Codex App dispatch route is available.', 'route_unavailable');
}

async function tryReconcileExistingCodexDispatch({ stateDir, draft, projectId, env, deps, signal, includeMessage }) {
  if (!deps.findExistingCodexDispatch || !deps.resolveCodexLocalProject) return null;
  try {
    const project = await deps.resolveCodexLocalProject({ projectId, env, signal });
    const match = await deps.findExistingCodexDispatch({
      projectPath: project.path,
      fromId: draft.from.id,
      messageId: draft.message_id,
      env,
      deps,
      signal,
    });
    if (!match) return null;
    const settled = await settleDelivery(stateDir, draft.from, draft.message_id, {
      status: 'submitted',
      targetId: match.id,
      transport: 'codex-app-native',
    });
    const delivery = publicDelivery(settled ?? { ...draft, to: { app: 'codex', id: match.id }, status: 'submitted' }, {
      includeMessage,
    });
    return { delivery, outcome: outcome('already_submitted', { record: delivery }) };
  } catch {
    return null;
  }
}

export function createTaskDispatcher({ stateDir, env, deps, getReachableAntigravityHosts }) {
  return async function dispatch(toolName, args, { metadata = {}, signal } = {}) {
    const fromApp = toolName === 'dispatch_to_codex' ? 'antigravity' : 'codex';
    const toApp = fromApp === 'codex' ? 'antigravity' : 'codex';
    if (detectHostApp({ env, metadata }) !== fromApp) {
      throw failure(`${toolName} requires a verified ${fromApp} caller.`, 'wrong_tool');
    }
    const projectId = requiredText(args, 'project_id', 128).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId) || projectId === 'outside-of-project') {
      throw failure('project_id must identify an existing local project.', 'invalid_argument');
    }
    const title = requiredText(args, 'title', 120).trim();
    const message = requiredText(args, 'message', MAX_MESSAGE_BYTES);
    if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
      throw failure('message exceeds 65536 UTF-8 bytes.', 'message_too_long');
    }
    const authorizationRef = requiredText(args, 'authorization_ref', 2048).trim();
    const messageId = requiredText(args, 'message_id', 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(messageId)) throw failure('Invalid dispatch message_id.', 'invalid_argument');

    const caller = fromApp === 'codex'
      ? resolveCodexCaller({ env, metadata })
      : resolveAntigravityCaller({ toolName, stateDir, env, metadata, args });
    const draft = {
      from: { app: fromApp, id: caller.id },
      to: { app: toApp, id: null },
      project_id: projectId,
      title,
      message,
      authorization_ref: authorizationRef,
      message_id: messageId,
    };
    const includeMessage = args.include_message === true;
    let reserved;
    try {
      reserved = await reserveDelivery(stateDir, draft, { retryFailed: args.retry_failed === true, signal });
    } catch (error) {
      // If a previous Codex dispatch ended uncertain, check the target project by message_id first.
      if (toApp === 'codex' && error.reason === 'prior_uncertain') {
        const reconciled = await tryReconcileExistingCodexDispatch({
          stateDir, draft, projectId, env, deps, signal, includeMessage,
        });
        if (reconciled) return reconciled;
      }
      if (error.record) {
        error.record = publicDelivery(error.record, { includeMessage });
        error.outcome = outcome(error.reason, { record: error.record });
      }
      throw error;
    }
    if (reserved.action === 'replay') {
      const delivery = publicDelivery(reserved.record, { includeMessage });
      return { delivery, outcome: outcome('already_submitted', { record: delivery }) };
    }

    let receipt;
    let record;
    try {
      const hosts = await getReachableAntigravityHosts(signal);
      if (fromApp === 'antigravity') await verifyAntigravityCaller(hosts, caller, deps, signal);
      else if (!isCodexMain(await readCodex(deps, env, caller.id, signal))) {
        throw failure('Dispatch requires a verified Codex main conversation.', 'caller_unverified');
      }
      const options = { stateDir, hosts, projectId, deps, env, signal };
      const target = await (toApp === 'codex' ? prepareCodex(options) : prepareAntigravity(options));

      // Guard against duplicate creation before touching UI/deep-link if an existing thread already holds this message_id.
      if (toApp === 'codex' && target.projectPath && deps.findExistingCodexDispatch) {
        const existing = await deps.findExistingCodexDispatch({
          projectPath: target.projectPath,
          fromId: caller.id,
          messageId,
          env,
          deps,
          signal,
        }).catch(() => null);
        if (existing) {
          record = await settleDelivery(stateDir, draft.from, messageId, {
            status: 'submitted', targetId: existing.id, transport: 'codex-app-native',
          });
          const delivery = publicDelivery(record ?? reserved.record, { includeMessage });
          return { delivery, outcome: outcome('already_submitted', { record: delivery }) };
        }
      }

      const body = `Authorization reference (verify against the user's decision): ${authorizationRef}\n\n${message}`;
      const text = formatPeerEnvelope({ fromApp, fromId: caller.id, messageId, body });
      receipt = await target.create({ title, text, messageId, fromId: caller.id });
      if (!(await target.verify(receipt.id))) {
        throw unconfirmedReply(toApp, 'the new conversation did not verify in the target project');
      }
      record = await settleDelivery(stateDir, draft.from, messageId, {
        status: 'submitted', targetId: receipt.id, transport: receipt.transport,
      });
      if (!record) throw unconfirmedReply(toApp, 'the creation receipt could not be saved');
    } catch (cause) {
      const error = receipt && !cause.deliveryUnknown
        ? markDeliveryUnknown(failure('The conversation was created, but verification or receipt storage failed.'))
        : cause;
      const status = error.deliveryUnknown ? 'uncertain' : 'failed';
      record = await settleDelivery(stateDir, draft.from, messageId, {
        status, error: error.message, error_reason: error.reason,
        targetId: receipt?.id, transport: receipt?.transport,
      }).catch(() => null);
      const delivery = publicDelivery(record ?? reserved.record, { includeMessage });
      error.record = delivery;
      error.outcome = outcome(error.reason, { record: delivery });
      throw error;
    }

    return { delivery: publicDelivery(record, { includeMessage }), outcome: outcome('submitted') };
  };
}
