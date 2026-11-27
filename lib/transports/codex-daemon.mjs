// Cross-platform Codex App-Server Daemon transport.
// Speaks JSON-RPC over WebSocket through `codex app-server proxy`.
// Zero version-string comparison: relies strictly on protocol capability responses.
import { spawn } from 'node:child_process';
import { beforeWrite, cancelledError, monotonicNow, throwIfStopped } from '../core/call-time.mjs';
import { failure, markDeliveryUnknown, tagged, unconfirmedReply } from '../core/outcome.mjs';
import { FrameDecoder, encodeClose, encodePong, encodeText, upgradeRequest } from '../core/ws-jsonrpc.mjs';
import {
  DaemonUnavailableError,
  isCodexThreadUuid,
  normalizeCodexThreadId,
  queueToCodexThread,
  resolveCodexRuntimeBin,
} from './codex-queue.mjs';

export { DaemonUnavailableError, isCodexThreadUuid, normalizeCodexThreadId, queueToCodexThread };

const THREAD_STATUSES = new Set(['idle', 'active', 'notLoaded', 'systemError']);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const NOT_RUNNING_MESSAGE =
  'No local Codex daemon is running. Start it with `codex app-server daemon start` (the bridge never starts it automatically).';

export class ThreadNotLoadedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThreadNotLoadedError';
    this.reason = 'target_unavailable';
  }
}

export function rpcReplyKind(reply, requireVersion = false) {
  if ((requireVersion || Object.hasOwn(reply, 'jsonrpc')) && reply.jsonrpc !== '2.0') return null;
  const hasResult = Object.hasOwn(reply, 'result');
  const hasError = Object.hasOwn(reply, 'error');
  if (hasResult === hasError) return null;
  if (hasResult) return isObject(reply.result) ? 'result' : null;
  return isObject(reply.error) && Number.isInteger(reply.error.code) && typeof reply.error.message === 'string'
    ? 'error'
    : null;
}

function appServerError(source, { code, message, data }) {
  if (/^(?:access (?:is )?denied|permission denied|unauthorized|forbidden)(?:[.: ]|$)/i.test(message)) {
    return failure('The Codex app server denied this request. Check authorization.', 'access_denied', { rpcCode: code });
  }
  const notFound = code === -32600 && /^thread not found(?::|$)/i.test(message);
  const reason = notFound
    ? 'target_unavailable'
    : code === -32601
      ? 'protocol_incompatible'
      : code === -32602 && /^invalid params(?::|$)/i.test(message)
        ? 'request_rejected'
        : 'internal_error';
  const detail =
    reason === 'target_unavailable'
      ? 'The selected Codex thread was not found.'
      : reason === 'protocol_incompatible'
        ? 'The Codex app server does not support this method.'
        : reason === 'request_rejected'
          ? 'The Codex app server rejected the request arguments.'
          : message || 'The Codex app server reported an internal error.';
  return failure(`${source}: ${detail}`, reason, { rpcCode: code, rpcMessage: message, rpcData: data });
}

export function openDaemon({ env = process.env, command, args, signal, timeoutMs = 10_000 } = {}) {
  try {
    throwIfStopped(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  const effective = { ...process.env, ...env };
  let executable;
  try {
    executable = resolveCodexRuntimeBin(effective, command);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolveOpen, rejectOpen) => {
    let child;
    try {
      child = spawn(executable, args ?? ['app-server', 'proxy'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: effective,
      });
    } catch (error) {
      rejectOpen(
        ['EACCES', 'EPERM'].includes(error?.code)
          ? failure('Access to Codex CLI was denied.', 'access_denied')
          : new DaemonUnavailableError('Could not launch Codex app-server proxy.'),
      );
      return;
    }

    const upgrade = upgradeRequest();
    const decoder = new FrameDecoder({ accept: upgrade.accept });
    const waiting = new Map();
    let nextId = 1;
    let opened = false;
    let closed = false;
    let closeCause;
    let stderr = '';

    const connectTimer = setTimeout(() => {
      fail(new DaemonUnavailableError('Timed out connecting to the local Codex daemon.'));
    }, timeoutMs);
    connectTimer.unref?.();

    function fail(error) {
      if (closed) return;
      closed = true;
      closeCause = error;
      clearTimeout(connectTimer);
      signal?.removeEventListener('abort', onAbort);
      try {
        child.kill();
      } catch {
        // ignore
      }
      for (const entry of waiting.values()) {
        const copy = Object.assign(new Error(error.message), {
          name: error.name,
          reason: error.reason || 'route_unavailable',
          code: error.code,
        });
        if (entry.mutating && entry.written) {
          if (error.reason === 'protocol_incompatible') unconfirmedReply('Codex daemon', 'malformed response', copy);
          else markDeliveryUnknown(copy);
        }
        entry.reject(copy);
      }
      waiting.clear();
      if (!opened) rejectOpen(error);
    }

    const onAbort = () => fail(cancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });

    const write = buf => child.stdin.write(buf);

    function request(method, params, { mutating = false, signal: reqSignal, timeoutMs: limit = 15_000 } = {}) {
      if (closed) return Promise.reject(closeCause ?? new DaemonUnavailableError('Codex daemon connection is closed.'));
      try {
        throwIfStopped(reqSignal);
      } catch (error) {
        return Promise.reject(error);
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const entry = { mutating, written: false, resolve: null, reject: null };
        const timer = setTimeout(() => {
          fail(failure('Codex daemon did not reply before the request timeout.', 'deadline'));
        }, limit);
        timer.unref?.();
        const onReqAbort = () => fail(cancelledError());
        const cleanup = () => {
          clearTimeout(timer);
          reqSignal?.removeEventListener('abort', onReqAbort);
        };
        entry.resolve = val => {
          cleanup();
          resolve(val);
        };
        entry.reject = err => {
          cleanup();
          reject(err);
        };
        reqSignal?.addEventListener('abort', onReqAbort, { once: true });
        waiting.set(id, entry);
        try {
          const frame = encodeText(JSON.stringify({ id, method, params }));
          if (mutating) beforeWrite(reqSignal);
          entry.written = true;
          write(frame);
        } catch (error) {
          waiting.delete(id);
          entry.reject(mutating && entry.written ? markDeliveryUnknown(error) : error);
        }
      });
    }

    const notify = (method, params) => write(encodeText(JSON.stringify({ method, params })));

    function handleText(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        fail(failure('Codex daemon returned invalid JSON.', 'protocol_incompatible'));
        return;
      }
      if (!isObject(msg) || (!Object.hasOwn(msg, 'method') && !Object.hasOwn(msg, 'id'))) {
        fail(failure('Codex daemon returned a malformed JSON-RPC frame.', 'protocol_incompatible'));
        return;
      }
      if (Object.hasOwn(msg, 'method')) return;
      const entry = waiting.get(msg.id);
      if (!entry) return;
      const kind = rpcReplyKind(msg);
      if (!kind) {
        fail(failure('Codex daemon returned an invalid JSON-RPC reply.', 'protocol_incompatible'));
        return;
      }
      waiting.delete(msg.id);
      if (kind === 'error') entry.reject(appServerError('Codex daemon', msg.error));
      else entry.resolve(msg.result);
    }

    async function afterUpgrade() {
      try {
        await request('initialize', {
          clientInfo: { name: 'antigravity-codex-bridge', title: 'Antigravity–Codex Bridge', version: 'bridge' },
        });
        notify('initialized', {});
        opened = true;
        clearTimeout(connectTimer);
        resolveOpen({
          request,
          close() {
            if (closed) return;
            try {
              write(encodeClose());
            } catch {
              // ignore
            }
            fail(new DaemonUnavailableError('Codex daemon connection closed.'));
          },
        });
      } catch (error) {
        fail(error);
      }
    }

    child.on('error', err => {
      fail(
        ['EACCES', 'EPERM'].includes(err?.code)
          ? failure('Access to Codex CLI was denied.', 'access_denied')
          : new DaemonUnavailableError('Could not start Codex app-server proxy.'),
      );
    });
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on('close', code => {
      if (/permission denied|access is denied|os error (?:5|13)\b/i.test(stderr)) {
        fail(failure('Access to Codex daemon was denied.', 'access_denied'));
        return;
      }
      if (opened) {
        fail(
          code === 0
            ? new DaemonUnavailableError('Codex daemon proxy disconnected.')
            : failure('Codex daemon connection closed unexpectedly.', 'route_unavailable'),
        );
        return;
      }
      const notRunning =
        /failed to connect/i.test(stderr) &&
        /connection refused|no such file or directory|cannot find the file|os error (?:2|61|111|10061)\b/i.test(stderr);
      fail(new DaemonUnavailableError(notRunning ? NOT_RUNNING_MESSAGE : 'Local Codex daemon is not reachable.'));
    });

    child.stdout.on('data', chunk => {
      let events = [];
      let invalid = null;
      try {
        events = decoder.push(chunk);
      } catch (error) {
        events = error.events ?? [];
        invalid = error;
      }
      for (const ev of events) {
        if (ev.type === 'open') afterUpgrade();
        else if (ev.type === 'text') handleText(ev.text);
        else if (ev.type === 'ping') {
          try {
            write(encodePong(ev.payload));
          } catch {
            // closing
          }
        } else if (ev.type === 'close') {
          fail(
            ev.code === 1008
              ? failure('Codex daemon denied the connection.', 'access_denied')
              : new DaemonUnavailableError('Codex daemon closed the connection.'),
          );
        }
      }
      if (invalid) fail(invalid);
    });

    write(Buffer.from(upgrade.text, 'latin1'));
  });
}

function summarizeThread(thread) {
  return {
    thread_id: normalizeCodexThreadId(thread.id),
    title: String(thread.name || thread.preview || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    status: thread.status.type,
    cwd: String(thread.cwd ?? ''),
    source: 'daemon',
  };
}

export async function listDaemonThreads(conn, { limit = 30, signal, timeoutMs = 8_000, budgetMs = 5_000 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 30, 50));
  const found = [];
  let cursor = null;
  const until = monotonicNow() + budgetMs;

  for (let page = 0; page < 20 && found.length < capped && (page === 0 || monotonicNow() < until); page++) {
    const result = await conn.request(
      'thread/list',
      { limit: 50, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) },
      { signal, timeoutMs },
    );
    if (!Array.isArray(result?.data)) {
      throw failure('Codex daemon returned an unsupported thread list shape.', 'protocol_incompatible');
    }
    for (const thread of result.data) {
      if (typeof thread?.id !== 'string' || !thread.id.trim()) continue;
      if (!THREAD_STATUSES.has(thread?.status?.type) || thread.status.type === 'systemError') continue;
      found.push(summarizeThread(thread));
      if (found.length >= capped) break;
    }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    if (!cursor) break;
  }
  return found;
}

export async function readDaemonThread(conn, threadId, { signal, timeoutMs = 8_000 } = {}) {
  const id = normalizeCodexThreadId(threadId);
  try {
    const result = await conn.request('thread/read', { threadId: id, includeTurns: false }, { signal, timeoutMs });
    const thread = result?.thread;
    if (!isObject(thread) || !isObject(thread.status) || !THREAD_STATUSES.has(thread.status.type)) {
      throw failure('Codex daemon returned an unsupported thread object.', 'protocol_incompatible');
    }
    if (normalizeCodexThreadId(thread.id) !== id) {
      throw failure('Codex daemon returned a different thread than requested.', 'target_unavailable');
    }
    return { ...thread, id };
  } catch (error) {
    if (error?.reason === 'target_unavailable' && error?.rpcCode === -32600) return null;
    throw error;
  }
}

const isStaleSteer = error =>
  error?.rpcCode === -32600 &&
  error?.rpcData?.codexErrorInfo?.activeTurnNotSteerable === undefined &&
  /^(no active turn to steer|expected active turn id `[^`]+` but found `[^`]+`)$/i.test(String(error?.rpcMessage || ''));

function findActiveTurnId(turns) {
  const running = [...turns].reverse().find(t => t?.status === 'inProgress' || t?.status?.type === 'inProgress');
  return typeof running?.id === 'string' && running.id.trim() ? running.id : null;
}

async function writeTurn(conn, method, params, signal) {
  let result;
  try {
    result = await conn.request(method, params, { mutating: true, signal });
  } catch (error) {
    if (error?.rpcMessage === undefined) throw error;
    const notSteerableKind = error?.rpcData?.codexErrorInfo?.activeTurnNotSteerable?.turnKind;
    if (
      method === 'turn/steer' &&
      error.rpcCode === -32600 &&
      (['review', 'compact'].includes(notSteerableKind) || isStaleSteer(error))
    ) {
      throw tagged(error, 'target_busy');
    }
    if (['target_unavailable', 'protocol_incompatible', 'request_rejected'].includes(error.reason)) throw error;
    throw unconfirmedReply('Codex daemon', undefined, error);
  }
  const turnId = method === 'turn/start' ? result?.turn?.id : result?.turnId === params.expectedTurnId ? result.turnId : null;
  if (typeof turnId !== 'string' || !turnId.trim()) {
    throw unconfirmedReply('Codex daemon', `unexpected ${method} receipt`);
  }
  return { method, turnId };
}

export async function sendToDaemonThread(conn, { threadId, text, messageId, allowSteer = true, signal, timeoutMs = 8_000 } = {}) {
  const id = normalizeCodexThreadId(threadId);
  const thread = await readDaemonThread(conn, id, { signal, timeoutMs });
  if (!thread) throw failure('The selected Codex thread was not found in the local daemon.', 'target_unavailable');

  const status = thread.status.type;
  if (status === 'notLoaded') throw new ThreadNotLoadedError('The selected Codex thread is not loaded in the local daemon.');
  if (status === 'systemError') {
    throw failure('The selected Codex thread is in a systemError state. Resolve it in Codex first.', 'target_unavailable');
  }

  const input = [{ type: 'text', text }];
  if (status === 'idle') {
    return writeTurn(conn, 'turn/start', { threadId: id, input, clientUserMessageId: messageId }, signal);
  }
  if (!allowSteer) {
    throw failure('The selected Codex thread is currently busy. Retry when it is idle or allow steering.', 'target_busy');
  }

  const turns = await conn.request('thread/turns/list', { threadId: id, limit: 1 }, { signal, timeoutMs });
  if (!Array.isArray(turns?.data)) {
    throw failure('Codex daemon returned an unsupported turn list.', 'protocol_incompatible');
  }
  const expectedTurnId = findActiveTurnId(turns.data);
  if (!expectedTurnId) {
    throw failure('The selected Codex thread is busy and its active turn could not be identified.', 'target_busy');
  }

  try {
    return await writeTurn(conn, 'turn/steer', { threadId: id, expectedTurnId, input }, signal);
  } catch (error) {
    if (!isStaleSteer(error)) throw error;
    const refreshed = await readDaemonThread(conn, id, { signal, timeoutMs });
    if (!refreshed || refreshed.status.type === 'notLoaded') {
      throw failure('The selected Codex thread is no longer loaded.', 'target_unavailable');
    }
    if (refreshed.status.type !== 'idle') {
      throw failure('The selected Codex thread changed turns while sending. Retry shortly.', 'target_busy');
    }
    return writeTurn(conn, 'turn/start', { threadId: id, input, clientUserMessageId: messageId }, signal);
  }
}
