// `codex queue` CLI fallback transport for threads not loaded in the local daemon.
import { execFile } from 'node:child_process';
import { debuglog } from 'node:util';
import { beforeWrite, throwIfStopped } from '../core/call-time.mjs';
import { failure, markDeliveryUnknown, unconfirmedReply } from '../core/outcome.mjs';
import { resolveCodexExecutable } from './codex-binary.mjs';

const DISABLED_RE = /^(off|0|false|no|disabled?)$/i;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const QUEUED_RE = /Queued message (\S+) for thread (\S+?)\.?\s*$/m;
const WIN_QUEUE_TEXT_LIMIT = 16_000;
const UNIX_QUEUE_TEXT_LIMIT = 65_536;

export class DaemonUnavailableError extends Error {
  constructor(message, { terminalUnavailable = false } = {}) {
    super(message);
    this.name = 'DaemonUnavailableError';
    this.reason = 'route_unavailable';
    this.terminalUnavailable = terminalUnavailable;
  }
}

export function isCodexThreadUuid(id) {
  return typeof id === 'string' && id.length === 36 && UUID_RE.test(id);
}

export function normalizeCodexThreadId(id) {
  return isCodexThreadUuid(id) ? id.toLowerCase() : String(id ?? '').trim();
}

export function resolveCodexRuntimeBin(effective, commandOverride) {
  if (debuglog('child_process').enabled) {
    throw new DaemonUnavailableError(
      'Disable NODE_DEBUG=child_process before using the bridge so message text is not logged.',
      { terminalUnavailable: true },
    );
  }
  if (commandOverride) return commandOverride;
  const disabled = String(effective.AGY_CODEX_BRIDGE_DAEMON ?? '').trim();
  if (DISABLED_RE.test(disabled)) {
    throw new DaemonUnavailableError(`Codex daemon/queue route is disabled by AGY_CODEX_BRIDGE_DAEMON=${disabled}.`, {
      terminalUnavailable: true,
    });
  }
  const executable = resolveCodexExecutable({ env: effective });
  if (!executable) {
    throw new DaemonUnavailableError(
      'Codex CLI executable was not found. Install Codex CLI or set AGY_CODEX_BRIDGE_CODEX_BIN.',
      { terminalUnavailable: true },
    );
  }
  return executable;
}

export function queueToCodexThread({ threadId, text, env = process.env, signal, timeoutMs = 25_000, command, args } = {}) {
  try {
    throwIfStopped(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  const id = normalizeCodexThreadId(threadId);
  if (!isCodexThreadUuid(id)) {
    return Promise.reject(failure('Codex queue delivery requires an exact session UUID.', 'invalid_argument'));
  }
  if (typeof text !== 'string' || text.includes('\0')) {
    return Promise.reject(failure('Message text must be a valid string without NUL bytes.', 'invalid_argument'));
  }
  const limit = process.platform === 'win32' ? WIN_QUEUE_TEXT_LIMIT : UNIX_QUEUE_TEXT_LIMIT;
  if (text.length > limit) {
    return Promise.reject(
      failure(`Message exceeds Codex queue length limit (${limit} UTF-16 units including wrapper).`, 'message_too_long'),
    );
  }
  const effective = { ...process.env, ...env };
  let executable;
  try {
    executable = resolveCodexRuntimeBin(effective, command);
  } catch (error) {
    return Promise.reject(error);
  }
  try {
    beforeWrite(signal);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    try {
      execFile(
        executable,
        [...(args ?? []), 'queue', '--thread', id, '--message', text],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 65_536, env: effective, signal },
        (error, stdout, stderr) => {
          if (error) {
            const startFail = typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
            if (startFail) {
              reject(
                ['EACCES', 'EPERM'].includes(error.code)
                  ? failure('Access to Codex CLI was denied.', 'access_denied')
                  : new DaemonUnavailableError('Could not launch `codex queue`.'),
              );
              return;
            }
            if (/no rollout found for thread id|No active session found matching/i.test(String(stderr))) {
              reject(failure('The selected Codex thread was not found in the local thread store.', 'target_unavailable'));
              return;
            }
            reject(unconfirmedReply('Codex queue', 'command did not complete cleanly'));
            return;
          }
          const match = QUEUED_RE.exec(String(stdout));
          if (match && normalizeCodexThreadId(match[2]) === id) {
            resolve({ method: 'queue', queueId: match[1] });
          } else {
            reject(unconfirmedReply('Codex queue', 'unexpected receipt'));
          }
        },
      );
    } catch (error) {
      reject(markDeliveryUnknown(error));
    }
  });
}
