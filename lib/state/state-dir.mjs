// Shared state directory resolution with owner-only permissions (0700).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failure } from '../core/outcome.mjs';

export const STATE_DIR_ENV = 'AGY_CODEX_BRIDGE_STATE_DIR';

export function resolveStateDir(env = process.env) {
  const override = String(env[STATE_DIR_ENV] ?? '').trim();
  if (override) return path.resolve(override);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.local', 'share', 'antigravity-codex-bridge');
}

export function ensurePrivateDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(dirPath, 0o700);
      } catch {
        // Ignore chmod errors on filesystems that do not support POSIX mode bits.
      }
    }
    return dirPath;
  } catch (error) {
    throw failure(`Bridge state directory is unavailable (${error.code || error.message}).`, 'state_unavailable');
  }
}

export function writePrivateJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync may fail on virtual/network filesystems; best-effort.
    }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Best-effort permission tightening.
      }
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw failure(`Failed to write bridge state file (${error.code || error.message}).`, 'state_unavailable');
  }
}

export function readBoundedJson(filePath, maxBytes = 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      throw failure(`Bridge state file exceeds size limit (${maxBytes} bytes).`, 'state_unavailable');
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.reason) throw error;
    throw failure(`Bridge state file is unreadable or corrupt (${error.message}).`, 'state_unavailable');
  }
}
