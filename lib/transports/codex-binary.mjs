// Cross-platform Codex executable discovery without hardcoding versions or OS-specific extensions.
import fs from 'node:fs';
import path from 'node:path';

const WIN_PLATFORMS = {
  x64: ['codex-win32-x64', 'x86_64-pc-windows-msvc'],
  arm64: ['codex-win32-arm64', 'aarch64-pc-windows-msvc'],
};
const WIN_LAUNCHER_RE = /"((?:%~?dp0%?|[A-Za-z]:)[^"\r\n]*[\\/]codex\.js)"/i;
const VOLTA_SOURCE_DIRS = ['', '5', 'lib'];

function isExecutableFile(filePath, platform) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveWindowsVendored(directory, arch) {
  const roots = [];
  try {
    const shim = fs.readFileSync(path.join(directory, 'codex.cmd'), 'utf8').slice(0, 8192);
    const match = WIN_LAUNCHER_RE.exec(shim);
    if (match?.[1]) {
      const normalized = path.normalize(match[1].replace(/^%~?dp0%?/i, () => directory));
      roots.push(path.dirname(path.dirname(normalized)));
    }
    if (/\bvolta run\b/i.test(shim) && path.basename(directory).toLowerCase() === 'bin') {
      const image = path.join(path.dirname(directory), 'tools', 'image', 'packages', '@openai', 'codex');
      for (const sub of VOLTA_SOURCE_DIRS) roots.push(path.join(image, sub, 'node_modules', '@openai', 'codex'));
    }
  } catch {
    // Fallback to standard npm node_modules layout.
  }
  roots.push(path.join(directory, 'node_modules', '@openai', 'codex'));

  const targets = [arch, ...Object.keys(WIN_PLATFORMS).filter(k => k !== arch)]
    .filter(k => WIN_PLATFORMS[k])
    .map(k => WIN_PLATFORMS[k]);

  for (const root of roots) {
    let dir;
    try {
      dir = fs.realpathSync(root);
    } catch {
      dir = root;
    }
    for (;;) {
      if (path.basename(dir) !== 'node_modules') {
        for (const [pkg, triple] of targets) {
          const candidate = path.join(dir, 'node_modules', '@openai', pkg, 'vendor', triple, 'bin', 'codex.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function resolveCodexExecutable({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const override = String(env.AGY_CODEX_BRIDGE_CODEX_BIN ?? '').trim();
  if (override) {
    return isExecutableFile(override, platform) ? override : null;
  }

  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  const rawDirs = String(env[pathKey] ?? '').split(path.delimiter).filter(Boolean);
  const dirs =
    platform === 'darwin'
      ? [...new Set([...rawDirs, '/opt/homebrew/bin', '/usr/local/bin'])]
      : rawDirs;

  for (const dir of dirs) {
    if (platform === 'win32') {
      const exe = path.join(dir, 'codex.exe');
      if (isExecutableFile(exe, platform)) return exe;
      if (fs.existsSync(path.join(dir, 'codex.cmd'))) {
        const vendored = resolveWindowsVendored(dir, arch);
        if (vendored) return vendored;
      }
    } else {
      const bin = path.join(dir, 'codex');
      if (isExecutableFile(bin, platform)) return bin;
    }
  }
  return null;
}
