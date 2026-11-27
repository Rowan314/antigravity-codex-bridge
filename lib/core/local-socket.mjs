// Cross-platform local IPC endpoint validation and non-intrusive presence checks.
import fs from 'node:fs';
import { posix } from 'node:path';

const PIPE_ROOT = '\\\\.\\pipe\\';

export function canonicalLocalSocket(socketPath, platform = process.platform) {
  if (typeof socketPath !== 'string' || !socketPath || /[\r\n\0]/.test(socketPath)) return null;
  if (platform === 'win32') {
    const match = /^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i.exec(socketPath);
    if (!match || ['.', '..'].includes(match[2]) || /[. ]$/.test(match[2])) return null;
    if (socketPath.startsWith('\\\\?\\') && socketPath.includes('/')) return null;
    const name = `${match[1] ? 'LOCAL\\' : ''}${match[2]}`.replace(/[A-Z]/g, c => c.toLowerCase());
    return `\\\\.\\pipe\\${name}`;
  }
  const maxBytes = platform === 'darwin' ? 103 : platform === 'linux' ? 107 : 0;
  if (
    !maxBytes ||
    !posix.isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath, 'utf8') > maxBytes ||
    posix.resolve(socketPath) !== socketPath ||
    socketPath.endsWith('/')
  ) {
    return null;
  }
  return socketPath;
}

function listWindowsPipes() {
  const names = new Set();
  const dir = fs.opendirSync(PIPE_ROOT);
  try {
    for (let entry; (entry = dir.readSync()); ) {
      names.add(entry.name.replace(/[A-Z]/g, c => c.toLowerCase()));
    }
  } finally {
    dir.closeSync();
  }
  return names;
}

export function createLocalSocketChecker(platform = process.platform) {
  let cachedPipes;
  return socketPath => {
    const canonical = canonicalLocalSocket(socketPath, platform);
    if (!canonical) return undefined;
    try {
      if (platform !== 'win32') {
        return fs.lstatSync(canonical).isSocket();
      }
      const name = canonical.slice(PIPE_ROOT.length);
      if (name.includes('\\') || /[^\x20-\x7e]/.test(name)) return undefined;
      cachedPipes ??= listWindowsPipes();
      return cachedPipes.has(name);
    } catch (error) {
      if (platform !== 'win32' && error?.code === 'ENOENT') return false;
      return undefined;
    }
  };
}
