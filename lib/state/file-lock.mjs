// Cross-process mutex implemented with atomic directory creation (mkdir).
// Safe across macOS, Linux, and Windows without native addons.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { throwIfStopped } from '../core/call-time.mjs';
import { failure } from '../core/outcome.mjs';
import { ensurePrivateDir } from './state-dir.mjs';

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function tryReclaimStaleLock(lockDir, nowMs) {
  try {
    const metaPath = path.join(lockDir, 'owner.json');
    let stale = false;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const age = nowMs - Number(meta.createdAt || 0);
      if (age > STALE_LOCK_MS && !isProcessAlive(meta.pid)) {
        stale = true;
      }
    } catch {
      const stat = fs.statSync(lockDir);
      if (nowMs - stat.mtimeMs > STALE_LOCK_MS) stale = true;
    }
    if (!stale) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function withStateLock(stateDir, fn, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, signal } = {}) {
  ensurePrivateDir(stateDir);
  const lockDir = path.join(stateDir, 'state.lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  const deadline = Date.now() + timeoutMs;

  let acquired = false;
  let attempt = 0;
  while (!acquired) {
    throwIfStopped(signal);
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
      acquired = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw failure(`Unable to acquire state lock (${error.code || error.message}).`, 'state_unavailable');
      }
      if (tryReclaimStaleLock(lockDir, Date.now())) continue;
      if (Date.now() >= deadline) {
        throw failure('Another bridge operation is currently holding the state lock. Retry shortly.', 'state_busy');
      }
      const backoff = Math.min(25 + attempt * 20, 150);
      attempt++;
      await delay(backoff, undefined, signal ? { signal } : undefined).catch(() => {
        throwIfStopped(signal);
      });
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
