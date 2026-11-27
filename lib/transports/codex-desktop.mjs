// Optional Codex Desktop app-tools local IPC adapter (Unix domain socket on macOS/Linux,
// named pipe on Windows). Uses dynamic `tools/list` schema probing; zero version binding.
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { beforeWrite, cancelledError, throwIfStopped } from '../core/call-time.mjs';
import { failure, markDeliveryUnknown, unconfirmedReply } from '../core/outcome.mjs';
import { normalizeCodexThreadId, rpcReplyKind } from './codex-daemon.mjs';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_DESKTOP_LIST_LIMIT = 50;

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) throw failure('Codex Desktop request exceeds 8 MiB.', 'message_too_long');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function desktopRequest(pipePath, method, params, { timeoutMs = 15_000, mutating = false, signal } = {}) {
  throwIfStopped(signal);
  if (typeof pipePath !== 'string' || !pipePath.trim()) {
    return Promise.reject(failure('Codex Desktop pipe path is missing.', 'route_unavailable'));
  }
  const id = 1;
  const frame = encodeFrame({ id, jsonrpc: '2.0', method, params });

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let pending = Buffer.alloc(0);
    let finished = false;
    let submitted = false;

    const timer = setTimeout(() => {
      fail(
        failure(
          submitted ? 'Codex Desktop did not answer before timeout.' : 'Codex Desktop did not accept the connection.',
          submitted ? 'delivery_unconfirmed' : 'route_unavailable',
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    function fail(error) {
      finish(mutating && submitted ? markDeliveryUnknown(error) : error);
    }

    function onAbort() {
      fail(cancelledError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    socket.on('connect', () => {
      if (finished) return;
      if (mutating) {
        try {
          beforeWrite(signal);
        } catch (error) {
          fail(error);
          return;
        }
      }
      submitted = true;
      socket.write(frame);
    });

    socket.on('error', error => {
      if (['EACCES', 'EPERM'].includes(error.code)) {
        fail(failure('Access to the Codex Desktop local pipe was denied.', 'access_denied'));
        return;
      }
      fail(failure(`Could not communicate with Codex Desktop (${error.code || error.message}).`, 'route_unavailable'));
    });

    socket.on('close', () => {
      if (!finished) fail(failure('Codex Desktop closed its local connection before replying.', 'route_unavailable'));
    });

    socket.on('data', chunk => {
      if (finished) return;
      pending = Buffer.concat([pending, chunk]);
      while (!finished && pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) {
          finish(
            mutating && submitted
              ? unconfirmedReply('Codex Desktop', 'invalid frame length')
              : failure('Codex Desktop returned an invalid frame length.', 'protocol_incompatible'),
          );
          return;
        }
        if (pending.length < length + 4) return;
        const payload = pending.subarray(4, length + 4);
        pending = pending.subarray(length + 4);
        let response;
        try {
          response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
        } catch {
          finish(
            mutating && submitted
              ? unconfirmedReply('Codex Desktop', 'invalid JSON')
              : failure('Codex Desktop returned invalid JSON.', 'protocol_incompatible'),
          );
          return;
        }
        if (!response || typeof response !== 'object' || Array.isArray(response)) continue;
        if (Object.hasOwn(response, 'method') || response.id !== id) continue;
        const kind = rpcReplyKind(response, true);
        if (kind === 'result') {
          finish(null, response.result);
        } else if (kind === 'error') {
          const { code, message } = response.error;
          const reason = code === -32601 ? 'protocol_incompatible' : code === -32602 ? 'request_rejected' : 'internal_error';
          finish(
            mutating && submitted && reason === 'internal_error'
              ? unconfirmedReply('Codex Desktop', message)
              : failure(`Codex Desktop rejected the request: ${message}`, reason),
          );
        } else {
          finish(
            mutating && submitted
              ? unconfirmedReply('Codex Desktop', 'malformed response')
              : failure('Codex Desktop returned a malformed JSON-RPC response.', 'protocol_incompatible'),
          );
        }
      }
    });
  });
}

export async function listDesktopTools(pipePath, { signal, timeoutMs = 6_000 } = {}) {
  const result = await desktopRequest(pipePath, 'tools/list', { threadStartKind: 'all' }, { signal, timeoutMs });
  if (!Array.isArray(result?.tools)) {
    throw failure('Codex Desktop returned no usable tools catalog.', 'protocol_incompatible');
  }
  return result.tools;
}

function findMessageTool(catalog) {
  return catalog.find(tool => {
    const props = tool?.inputSchema?.properties;
    return (
      tool?.name === 'send_message_to_thread' &&
      typeof tool?.namespace === 'string' &&
      tool.namespace &&
      props?.threadId?.type === 'string' &&
      props?.prompt?.type === 'string'
    );
  });
}

export async function listDesktopThreads({ pipePath, contextThreadId, limit = 30, signal, timeoutMs = 8_000 } = {}) {
  const catalog = await listDesktopTools(pipePath, { signal, timeoutMs });
  const tool = catalog.find(t => t?.name === 'list_threads' && typeof t?.namespace === 'string' && t.namespace);
  if (!tool) throw failure('Codex Desktop does not expose list_threads.', 'protocol_incompatible');

  const capped = Math.max(1, Math.min(Number(limit) || 30, MAX_DESKTOP_LIST_LIMIT));
  const result = await desktopRequest(
    pipePath,
    'tools/call',
    {
      arguments: { limit: capped },
      callerSource: 'codex',
      namespace: tool.namespace,
      tool: tool.name,
      threadId: contextThreadId,
      callId: `bridge-list-${randomUUID()}`,
      turnId: `bridge-list-${randomUUID()}`,
    },
    { signal, timeoutMs },
  );

  if (!result?.success || !Array.isArray(result?.contentItems)) {
    throw failure('Codex Desktop failed to list threads.', 'route_unavailable');
  }

  let listing = null;
  for (const item of result.contentItems) {
    if (item?.type !== 'inputText' || typeof item.text !== 'string') continue;
    try {
      const parsed = JSON.parse(item.text);
      if (Array.isArray(parsed?.threads)) {
        listing = parsed;
        break;
      }
    } catch {
      // Ignore non-JSON items.
    }
  }
  if (!listing) throw failure('Codex Desktop returned an unsupported thread listing.', 'protocol_incompatible');

  const seen = new Set();
  const rows = [];
  for (const item of [...(listing.pinnedThreads ?? []), ...listing.threads]) {
    if (item?.kind && item.kind !== 'codex') continue;
    if (item?.hostId != null && item.hostId !== 'local') continue;
    const id = item?.id || item?.threadId;
    if (typeof id !== 'string' || !id.trim()) continue;
    const normalized = normalizeCodexThreadId(id);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    rows.push({
      thread_id: normalized,
      title: String(item.title || '').slice(0, 200),
      status: String(item.status || 'unknown'),
      cwd: String(item.cwd || ''),
      source: 'desktop',
    });
    if (rows.length >= capped) break;
  }
  return rows;
}

export async function sendToDesktopThread({ pipePath, contextThreadId, threadId, text, signal, timeoutMs = 20_000 } = {}) {
  const catalog = await listDesktopTools(pipePath, { signal, timeoutMs: Math.min(timeoutMs, 8_000) });
  const tool = findMessageTool(catalog);
  if (!tool) throw failure('Codex Desktop does not expose a compatible send_message_to_thread tool.', 'protocol_incompatible');

  const args = { threadId: normalizeCodexThreadId(threadId), prompt: text };
  if (tool.inputSchema?.properties?.hostId) {
    args.hostId = 'local';
  }

  const result = await desktopRequest(
    pipePath,
    'tools/call',
    {
      arguments: args,
      callerSource: 'codex',
      namespace: tool.namespace,
      tool: tool.name,
      threadId: contextThreadId,
      callId: `bridge-send-${randomUUID()}`,
      turnId: `bridge-send-${randomUUID()}`,
    },
    { signal, timeoutMs, mutating: true },
  );

  if (!result?.success) {
    throw unconfirmedReply('Codex Desktop', 'tool call returned unsuccessful status');
  }
  return { method: 'desktop' };
}
