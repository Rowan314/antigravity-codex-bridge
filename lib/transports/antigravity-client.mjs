// Antigravity local transport adapter using official ConversationService HTTP+JSON
// and official `agentapi send-message` CLI. Zero version-string coupling.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attemptSignal, beforeWrite } from '../core/call-time.mjs';
import { failure, markDeliveryUnknown, unconfirmedReply } from '../core/outcome.mjs';
import { isValidLocalAddress } from '../state/host-registry.mjs';

export const MAX_ANTIGRAVITY_LIST_LIMIT = 50;

function ensureValidHost(host) {
  if (!host || !isValidLocalAddress(host.lsAddress) || typeof host.csrfToken !== 'string' || !host.csrfToken) {
    throw failure(
      'No reachable local Antigravity host is registered. Open or send a turn in Antigravity with the bridge plugin enabled.',
      'route_unavailable',
    );
  }
}

export async function probeAntigravityHost(host, { signal, timeoutMs = 3_000 } = {}) {
  if (!host || !isValidLocalAddress(host.lsAddress) || !host.csrfToken) return false;
  const attempt = attemptSignal(signal, timeoutMs);
  try {
    const res = await fetch(`http://${host.lsAddress}/healthz`, {
      method: 'GET',
      redirect: 'error',
      signal: attempt.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    attempt.dispose();
  }
}

async function conversationRpc(host, method, body, { signal, timeoutMs = 8_000 } = {}) {
  ensureValidHost(host);
  const attempt = attemptSignal(signal, timeoutMs);
  try {
    const res = await fetch(`http://${host.lsAddress}/product.v1.ConversationService/${method}`, {
      method: 'POST',
      redirect: 'error',
      signal: attempt.signal,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-antigravity-csrf-token': host.csrfToken,
      },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status === 401 || res.status === 403) {
      throw failure('Antigravity rejected the local request credentials. Refresh the Antigravity session.', 'access_denied');
    }
    if (res.status === 404) {
      throw failure('Antigravity conversation or service endpoint was not found.', 'target_unavailable');
    }
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw failure('Antigravity returned invalid JSON.', 'protocol_incompatible');
    }
    if (!res.ok) {
      const msg = String(parsed?.message || parsed?.error || `HTTP ${res.status}`);
      if (/not[_\s-]?found/i.test(msg) || parsed?.code === 'not_found') {
        throw failure('The selected Antigravity conversation was not found.', 'target_unavailable');
      }
      throw failure(`Antigravity ConversationService/${method} failed: ${msg}`, 'request_rejected');
    }
    return parsed;
  } catch (error) {
    if (error?.reason) throw error;
    if (signal?.aborted) throw failure('The Antigravity request was cancelled.', 'cancelled');
    throw failure(`Could not reach Antigravity at ${host.lsAddress}: ${error?.message || 'connection failed'}.`, 'route_unavailable');
  } finally {
    attempt.dispose();
  }
}

function summarizeConversation(conv, lsAddress) {
  const title = String(conv?.annotations?.title || '').trim();
  const summary = String(conv?.state?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    conversation_id: String(conv.id),
    title: title || summary || '(untitled)',
    summary,
    run_state: String(conv?.state?.runState || 'RUN_STATE_UNKNOWN'),
    project_id: String(conv?.metadata?.projectId || ''),
    parent_conversation_id: String(conv?.metadata?.parentConversationId || ''),
    archived: Boolean(conv?.annotations?.archived),
    update_time: String(conv?.state?.updateTime || ''),
    host_address: lsAddress,
  };
}

export async function listAntigravityConversations(
  host,
  { limit = 20, includeArchived = false, includeSubagents = false, signal, timeoutMs = 8_000 } = {},
) {
  const capped = Math.max(1, Math.min(Number(limit) || 20, MAX_ANTIGRAVITY_LIST_LIMIT));
  const payload = {
    pageSize: Math.min(100, Math.max(capped * 2, 20)),
    includeArchived: Boolean(includeArchived),
  };
  if (!includeSubagents) {
    // Empty string asks ConversationService for top-level conversations only.
    payload.parentConversationId = '';
  }
  const result = await conversationRpc(host, 'ListConversations', payload, { signal, timeoutMs });
  if (!Array.isArray(result?.conversations)) {
    throw failure('Antigravity returned an unexpected conversation list shape.', 'protocol_incompatible');
  }
  const rows = [];
  for (const conv of result.conversations) {
    if (typeof conv?.id !== 'string' || !conv.id.trim()) continue;
    if (!includeArchived && conv?.annotations?.archived) continue;
    if (!includeSubagents && conv?.metadata?.parentConversationId) continue;
    rows.push(summarizeConversation(conv, host.lsAddress));
    if (rows.length >= capped) break;
  }
  return rows;
}

export async function getAntigravityConversation(host, conversationId, { signal, timeoutMs = 8_000 } = {}) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    throw failure('conversation_id is required.', 'invalid_argument');
  }
  const conv = await conversationRpc(host, 'GetConversation', { conversationId: conversationId.trim() }, { signal, timeoutMs });
  if (!conv || typeof conv.id !== 'string' || !conv.id.trim()) {
    throw failure('Antigravity returned an unexpected conversation object.', 'protocol_incompatible');
  }
  return summarizeConversation(conv, host.lsAddress);
}

/**
 * Resolve how to invoke official `agentapi`.
 * Supports both the wrapper `~/.gemini/antigravity/bin/agentapi` and direct `language_server` binary
 * exposed via `ANTIGRAVITY_AGENTAPI_EXE` (which accepts `agentapi` as its first subcommand).
 */
export function resolveAgentapiCommand(host, env = process.env) {
  const explicit = String(env.AGY_CODEX_BRIDGE_AGENTAPI_BIN ?? '').trim();
  const home = env.HOME || os.homedir();
  const defaultWrapper = path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi');
  const candidates = [explicit, defaultWrapper, host?.agentapiBin].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const base = path.basename(candidate).toLowerCase();
    const needsSubcommand = base.includes('language_server');
    return { command: candidate, prefixArgs: needsSubcommand ? ['agentapi'] : [] };
  }

  // Fallback to PATH lookup for `agentapi`.
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'agentapi.exe' : 'agentapi');
    if (fs.existsSync(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }
  return null;
}

/**
 * Send a message into an existing Antigravity conversation via official `agentapi send-message`.
 * Never uses a shell; passes only the minimal required environment variables.
 */
export function sendToAntigravityConversation(
  host,
  { conversationId, title, text, env = process.env, signal, timeoutMs = 20_000 } = {},
) {
  ensureValidHost(host);
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    return Promise.reject(failure('conversation_id is required.', 'invalid_argument'));
  }
  if (typeof text !== 'string' || !text.trim()) {
    return Promise.reject(failure('message text is required.', 'invalid_argument'));
  }
  const resolved = resolveAgentapiCommand(host, env);
  if (!resolved) {
    return Promise.reject(
      failure(
        'Antigravity `agentapi` executable was not found. Ensure Antigravity is installed or set AGY_CODEX_BRIDGE_AGENTAPI_BIN.',
        'setup_incomplete',
      ),
    );
  }

  try {
    beforeWrite(signal);
  } catch (error) {
    return Promise.reject(error);
  }

  const args = [...resolved.prefixArgs, 'send-message'];
  if (typeof title === 'string' && title.trim()) {
    args.push(`--title=${title.trim().slice(0, 120)}`);
  }
  args.push(conversationId.trim(), text);

  const childEnv = {
    HOME: env.HOME || os.homedir(),
    PATH: env.PATH || '/usr/bin:/bin',
    ANTIGRAVITY_LS_ADDRESS: host.lsAddress,
    ANTIGRAVITY_CSRF_TOKEN: host.csrfToken,
  };

  return new Promise((resolve, reject) => {
    let written = false;
    try {
      written = true;
      execFile(
        resolved.command,
        args,
        { env: childEnv, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, signal },
        (error, stdout, stderr) => {
          const rawOut = String(stdout || '').trim();
          const rawErr = String(stderr || '').trim();
          let parsed = null;
          if (rawOut) {
            try {
              parsed = JSON.parse(rawOut);
            } catch {
              // Non-JSON output handled below.
            }
          }

          if (error) {
            const startFail = typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
            if (startFail) {
              reject(
                ['EACCES', 'EPERM'].includes(error.code)
                  ? failure('Access to Antigravity `agentapi` was denied.', 'access_denied')
                  : failure('Could not launch Antigravity `agentapi`.', 'setup_incomplete'),
              );
              return;
            }
            const errMsg = String(parsed?.error || rawErr || rawOut || error.message || '');
            if (/not[_\s-]?found|unknown conversation|invalid conversation/i.test(errMsg)) {
              reject(failure('The selected Antigravity conversation was not found.', 'target_unavailable'));
              return;
            }
            if (/ANTIGRAVITY_LS_ADDRESS|connection refused|dial tcp/i.test(errMsg)) {
              reject(failure('Could not connect to the registered Antigravity host.', 'route_unavailable'));
              return;
            }
            if (/unauthorized|forbidden|csrf/i.test(errMsg)) {
              reject(failure('Antigravity rejected the local CSRF token.', 'access_denied'));
              return;
            }
            reject(
              written
                ? unconfirmedReply('Antigravity agentapi', errMsg.slice(0, 160))
                : failure(`Antigravity send failed: ${errMsg}`, 'internal_error'),
            );
            return;
          }

          if (parsed && parsed.error) {
            const errMsg = String(parsed.error);
            if (/not[_\s-]?found/i.test(errMsg)) {
              reject(failure('The selected Antigravity conversation was not found.', 'target_unavailable'));
              return;
            }
            reject(unconfirmedReply('Antigravity agentapi', errMsg.slice(0, 160)));
            return;
          }

          resolve({ method: 'agentapi', receipt: parsed ?? { ok: true } });
        },
      );
    } catch (error) {
      reject(written ? markDeliveryUnknown(error) : failure('Failed to invoke `agentapi`.', 'setup_incomplete'));
    }
  });
}
