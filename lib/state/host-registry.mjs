// Shared endpoint registry for cross-client discovery and short-TTL caller binding.
// Stores Antigravity LS endpoints, Codex Desktop pipes, and Antigravity PreToolUse caller records.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalLocalSocket } from '../core/local-socket.mjs';
import { withStateLock } from './file-lock.mjs';
import { ensurePrivateDir, readBoundedJson, writePrivateJsonAtomic } from './state-dir.mjs';

const AGY_HOST_FILE = 'antigravity-host.json';
const CODEX_HOST_FILE = 'codex-host.json';
const CALLER_CTX_DIR = 'caller-context';
const MAX_HOSTS = 16;
const CALLER_CTX_TTL_MS = 15_000;
const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

export function isValidLocalAddress(address) {
  return typeof address === 'string' && LOCAL_HOST_RE.test(address.trim());
}

/** Deterministic hash of canonicalized tool arguments for PreToolUse -> MCP caller matching. */
export function hashToolArgs(args) {
  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  const json = JSON.stringify(canonicalize(args ?? {}));
  return crypto.createHash('sha256').update(json).digest('hex');
}

export async function registerAntigravityHost(stateDir, entry, { signal } = {}) {
  const lsAddress = String(entry?.lsAddress ?? '').trim();
  const csrfToken = String(entry?.csrfToken ?? '').trim();
  if (!isValidLocalAddress(lsAddress) || !csrfToken) return false;
  const agentapiBin = typeof entry.agentapiBin === 'string' && entry.agentapiBin.trim() ? entry.agentapiBin.trim() : null;
  const now = Date.now();

  await withStateLock(
    stateDir,
    () => {
      const file = path.join(stateDir, AGY_HOST_FILE);
      const existing = readBoundedJson(file, 64 * 1024);
      const hosts = Array.isArray(existing?.hosts) ? existing.hosts : [];
      const filtered = hosts.filter(item => item && item.lsAddress !== lsAddress);
      filtered.unshift({
        lsAddress,
        csrfToken,
        ...(agentapiBin ? { agentapiBin } : {}),
        pid: Number.isInteger(entry.pid) ? entry.pid : process.pid,
        updatedAt: now,
      });
      writePrivateJsonAtomic(file, { hosts: filtered.slice(0, MAX_HOSTS), updatedAt: now });
    },
    { signal },
  );
  return true;
}

export function listAntigravityHosts(stateDir) {
  const file = path.join(stateDir, AGY_HOST_FILE);
  try {
    const data = readBoundedJson(file, 64 * 1024);
    if (!Array.isArray(data?.hosts)) return [];
    return data.hosts.filter(h => h && isValidLocalAddress(h.lsAddress) && typeof h.csrfToken === 'string' && h.csrfToken);
  } catch {
    return [];
  }
}

export async function registerCodexDesktopHost(stateDir, entry, { signal } = {}) {
  const pipePath = canonicalLocalSocket(entry?.pipePath);
  const contextThreadId = String(entry?.contextThreadId ?? '').trim();
  if (!pipePath || !contextThreadId) return false;
  const now = Date.now();

  await withStateLock(
    stateDir,
    () => {
      const file = path.join(stateDir, CODEX_HOST_FILE);
      const existing = readBoundedJson(file, 64 * 1024);
      const hosts = Array.isArray(existing?.hosts) ? existing.hosts : [];
      const filtered = hosts.filter(item => item && item.pipePath !== pipePath);
      filtered.unshift({ pipePath, contextThreadId, updatedAt: now });
      writePrivateJsonAtomic(file, { hosts: filtered.slice(0, MAX_HOSTS), updatedAt: now });
    },
    { signal },
  );
  return true;
}

export function listCodexDesktopHosts(stateDir) {
  const file = path.join(stateDir, CODEX_HOST_FILE);
  try {
    const data = readBoundedJson(file, 64 * 1024);
    if (!Array.isArray(data?.hosts)) return [];
    return data.hosts.filter(h => h && canonicalLocalSocket(h.pipePath) && typeof h.contextThreadId === 'string' && h.contextThreadId);
  } catch {
    return [];
  }
}

/**
 * Record an Antigravity PreToolUse invocation context so the MCP server can bind
 * the exact calling conversationId without mutating tool arguments.
 */
export function recordCallerContext(stateDir, { toolName, args, conversationId, cwd = '' }) {
  if (!toolName || !conversationId) return null;
  const dir = ensurePrivateDir(path.join(stateDir, CALLER_CTX_DIR));
  const now = Date.now();
  pruneCallerContexts(dir, now);

  const normalizedTool = normalizeBridgeToolName(toolName);
  const argsHash = hashToolArgs(args);
  const id = `${now}-${crypto.randomBytes(6).toString('hex')}.json`;
  const record = {
    toolName: normalizedTool,
    rawToolName: toolName,
    argsHash,
    conversationId: String(conversationId).trim(),
    cwd: String(cwd || ''),
    ts: now,
  };
  writePrivateJsonAtomic(path.join(dir, id), record);
  return record;
}

export function normalizeBridgeToolName(name) {
  const raw = String(name || '').trim();
  // Strip any host/plugin MCP prefix such as "mcp__antigravity-codex-bridge__send_to_codex"
  // or "antigravity-codex-bridge:send_to_codex".
  const match = /(send_to_codex|send_to_antigravity|list_codex_threads|list_antigravity_conversations|list_deliveries|bridge_doctor)$/.exec(
    raw,
  );
  return match ? match[1] : raw;
}

function pruneCallerContexts(dir, now) {
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      try {
        const data = readBoundedJson(full, 16 * 1024);
        if (!data || now - Number(data.ts || 0) > CALLER_CTX_TTL_MS) {
          fs.unlinkSync(full);
        }
      } catch {
        try {
          fs.unlinkSync(full);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // Directory may not exist yet.
  }
}

/**
 * Resolve the calling Antigravity conversationId recorded by PreToolUse for this exact tool call.
 * Returns { conversationId } on unique match, { ambiguous: true } on concurrent identical-args conflict,
 * or null if no fresh hook record exists.
 */
export function consumeCallerContext(stateDir, { toolName, args, consume = true }) {
  const dir = path.join(stateDir, CALLER_CTX_DIR);
  const now = Date.now();
  const normalizedTool = normalizeBridgeToolName(toolName);
  const argsHash = hashToolArgs(args);

  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return null;
  }

  const matches = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let data;
    try {
      data = readBoundedJson(full, 16 * 1024);
    } catch {
      continue;
    }
    if (!data || now - Number(data.ts || 0) > CALLER_CTX_TTL_MS) {
      try {
        fs.unlinkSync(full);
      } catch {
        // ignore
      }
      continue;
    }
    if (data.toolName === normalizedTool && data.argsHash === argsHash) {
      matches.push({ file: full, data });
    }
  }

  if (matches.length === 0) return null;
  const distinctConvIds = [...new Set(matches.map(m => m.data.conversationId))];
  if (distinctConvIds.length > 1) {
    return { ambiguous: true, candidates: distinctConvIds.length };
  }

  matches.sort((a, b) => Number(b.data.ts) - Number(a.data.ts));
  const chosen = matches[0];
  if (consume) {
    try {
      fs.unlinkSync(chosen.file);
    } catch {
      // ignore
    }
  }
  return { conversationId: chosen.data.conversationId, cwd: chosen.data.cwd || '' };
}
