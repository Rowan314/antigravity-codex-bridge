// Caller host and conversation identity resolution for both Antigravity and Codex.
// Relies strictly on standard MCP metadata, official Antigravity PreToolUse hook context,
// and runtime environment variables—never version strings.
import { failure } from '../core/outcome.mjs';
import { consumeCallerContext } from '../state/host-registry.mjs';
import { normalizeCodexThreadId } from '../transports/codex-daemon.mjs';

export function detectHostApp({ env = process.env, metadata = {} } = {}) {
  const explicit = String(env.AGY_CODEX_BRIDGE_HOST ?? '').trim().toLowerCase();
  if (explicit === 'antigravity' || explicit === 'codex') return explicit;
  if (metadata['x-codex-turn-metadata'] || metadata['openai/threadId'] || metadata['openai/thread_id'] || metadata['codex/threadId']) {
    return 'codex';
  }
  if (env.CODEX_THREAD_ID || env.CODEX_APP_TOOLS_PIPE_PATH) return 'codex';
  if (metadata['antigravity/conversationId'] || env.ANTIGRAVITY_CONVERSATION_ID || env.ANTIGRAVITY_LS_ADDRESS) {
    return 'antigravity';
  }
  return null;
}

export function resolveCodexCaller({ metadata = {}, env = process.env } = {}) {
  let turnMeta = metadata['x-codex-turn-metadata'];
  if (typeof turnMeta === 'string') {
    try {
      turnMeta = JSON.parse(turnMeta);
    } catch {
      throw failure('Invalid Codex turn metadata in MCP request.', 'caller_unverified');
    }
  }
  if (turnMeta !== undefined && (turnMeta === null || typeof turnMeta !== 'object' || Array.isArray(turnMeta))) {
    throw failure('Invalid Codex turn metadata object in MCP request.', 'caller_unverified');
  }

  const rawCandidates = [
    turnMeta?.thread_id,
    metadata['openai/threadId'],
    metadata['openai/thread_id'],
    metadata['codex/threadId'],
    metadata.codexThreadId,
    metadata.codex_thread_id,
    metadata.threadId,
    metadata.thread_id,
    metadata.thread?.id,
  ].filter(v => v !== undefined);

  if (rawCandidates.some(v => typeof v !== 'string' || !v.trim())) {
    throw failure('Invalid Codex thread identity in MCP metadata.', 'caller_unverified');
  }

  const unique = [...new Set(rawCandidates.map(normalizeCodexThreadId))];
  if (unique.length > 1) {
    throw failure('Conflicting Codex thread identities in MCP metadata.', 'caller_unverified');
  }

  const threadId = unique[0] || (typeof env.CODEX_THREAD_ID === 'string' && env.CODEX_THREAD_ID.trim() ? normalizeCodexThreadId(env.CODEX_THREAD_ID) : null);
  if (!threadId) {
    throw failure(
      'Could not verify the calling Codex thread ID from MCP metadata or CODEX_THREAD_ID.',
      'caller_unverified',
    );
  }
  return { app: 'codex', id: threadId };
}

export function resolveAntigravityCaller({
  stateDir,
  toolName,
  args,
  metadata = {},
  env = process.env,
  consume = true,
} = {}) {
  // Layer 1: explicit MCP request metadata (if provided by the host).
  const metaCandidates = [
    metadata['antigravity/conversationId'],
    metadata['antigravity/conversation_id'],
    metadata.conversationId,
    metadata.conversation_id,
  ].filter(v => v !== undefined);

  if (metaCandidates.some(v => typeof v !== 'string' || !v.trim())) {
    throw failure('Invalid Antigravity conversation ID in MCP metadata.', 'caller_unverified');
  }
  const uniqueMeta = [...new Set(metaCandidates.map(v => v.trim()))];
  if (uniqueMeta.length > 1) {
    throw failure('Conflicting Antigravity conversation IDs in MCP metadata.', 'caller_unverified');
  }
  if (uniqueMeta.length === 1) {
    return { app: 'antigravity', id: uniqueMeta[0], source: 'metadata' };
  }

  // Layer 2: official Antigravity PreToolUse hook side-channel keyed by (toolName, sha256(args)).
  if (stateDir && toolName) {
    const matched = consumeCallerContext(stateDir, { toolName, args, consume });
    if (matched?.ambiguous) {
      throw failure(
        'Multiple Antigravity conversations issued an identical bridge call at the same moment. Retry once to disambiguate.',
        'caller_ambiguous',
      );
    }
    if (matched?.conversationId) {
      return { app: 'antigravity', id: matched.conversationId, source: 'hook' };
    }
  }

  // Layer 3: dedicated child-process environment variable fallback.
  const envId = String(env.ANTIGRAVITY_CONVERSATION_ID ?? '').trim();
  if (envId) {
    return { app: 'antigravity', id: envId, source: 'env' };
  }

  throw failure(
    'Could not verify the calling Antigravity conversation ID. Ensure the bridge plugin hooks are enabled in Antigravity.',
    'caller_unverified',
  );
}
