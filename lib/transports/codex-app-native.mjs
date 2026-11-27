// Native macOS Codex App dispatch transport using official `codex://threads/new` deep links
// and verified Accessibility UI confirmation (`scripts/codex-app-ui.swift`).
// Never uses `codex exec` or background thread creation; never pins client/server version strings.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { beforeWrite, throwIfStopped } from '../core/call-time.mjs';
import { failure, markDeliveryUnknown, unconfirmedReply } from '../core/outcome.mjs';
import { ensurePrivateDir } from '../state/state-dir.mjs';
import { listDaemonThreads, normalizeCodexThreadId, openDaemon, readDaemonThread } from './codex-daemon.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI_SWIFT_SOURCE = path.join(ROOT_DIR, 'scripts', 'codex-app-ui.swift');
const EXPECTED_MODEL_LABEL = 'GPT-6.2 Sol High';

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout ?? '');
        error.stderr = String(stderr ?? '');
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

function codexStateDbPath(env = process.env) {
  const codexHome = String(env.CODEX_HOME ?? '').trim() || path.join(env.HOME || os.homedir(), '.codex');
  return path.join(codexHome, '.codex-global-state.sqlite');
}

/**
 * Read Codex App's local project catalog from `.codex-global-state.sqlite` in read-only mode.
 */
export async function resolveCodexLocalProject({ projectId, env = process.env, signal } = {}) {
  throwIfStopped(signal);
  const dbPath = codexStateDbPath(env);
  if (!fs.existsSync(dbPath)) {
    throw failure('Codex local project state database was not found.', 'route_unavailable');
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'sqlite3',
      ['-readonly', dbPath, "SELECT value FROM settings WHERE scope='global' AND key='local-projects' LIMIT 1;"],
      { timeout: 4_000, signal },
    ));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw failure(`Could not read Codex local projects (${error.stderr || error.message}).`, 'route_unavailable');
  }
  const raw = stdout.trim();
  if (!raw) {
    throw failure('Codex local project catalog is empty.', 'target_unavailable');
  }
  let projects;
  try {
    projects = JSON.parse(raw);
  } catch {
    throw failure('Codex local project catalog is unreadable.', 'protocol_incompatible');
  }
  const entry = projects?.[projectId];
  const rootPaths = Array.isArray(entry?.rootPaths) ? entry.rootPaths.filter(p => typeof p === 'string' && p.trim()) : [];
  if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || rootPaths.length === 0) {
    throw failure(`The exact local Codex project ID '${projectId}' was not found.`, 'target_unavailable');
  }
  return {
    projectId,
    name: entry.name.trim(),
    path: rootPaths[0],
    rootPaths,
  };
}

/**
 * Compile and cache `scripts/codex-app-ui.swift` into `<stateDir>/bin/` keyed by source SHA-256.
 * Keeps UI verification fast (~50ms) without checking binaries into the repository.
 */
export async function ensureUiHelperBinary({ stateDir, signal } = {}) {
  throwIfStopped(signal);
  if (process.platform !== 'darwin') {
    throw failure('Native Codex App UI dispatch is currently supported on macOS only.', 'route_unavailable');
  }
  const source = fs.readFileSync(UI_SWIFT_SOURCE, 'utf8');
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  const binDir = ensurePrivateDir(path.join(stateDir, 'bin'));
  const binPath = path.join(binDir, `codex-app-ui-${hash}`);
  if (fs.existsSync(binPath)) return binPath;

  const tmpPath = `${binPath}.tmp.${process.pid}`;
  try {
    await execFileAsync('swiftc', ['-O', UI_SWIFT_SOURCE, '-o', tmpPath], { timeout: 30_000, signal });
    fs.renameSync(tmpPath, binPath);
    return binPath;
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (signal?.aborted) throw error;
    throw failure(`Could not compile native macOS UI helper: ${error.stderr || error.message}`, 'setup_incomplete');
  }
}

async function runUiHelper(binPath, subcommand, { input, timeoutMs = 12_000, signal } = {}) {
  try {
    const { stdout } = await execFileAsync(binPath, [subcommand], { input, timeout: timeoutMs, signal });
    return JSON.parse(stdout.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
    const raw = String(error.stdout || '').trim();
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        // fall through
      }
    }
    throw failure(`Native Codex App UI helper failed: ${error.stderr || error.message}`, 'internal_error');
  }
}

export async function probeCodexAppNative({ stateDir, env = process.env, signal } = {}) {
  if (process.platform !== 'darwin') {
    return {
      ready: false,
      reason: 'route_unavailable',
      detail: 'Native Codex App deep-link UI dispatch is only supported on macOS.',
    };
  }
  const dbPath = codexStateDbPath(env);
  if (!fs.existsSync(dbPath)) {
    return { ready: false, reason: 'route_unavailable', detail: 'Codex local state database was not found.' };
  }
  try {
    const binPath = await ensureUiHelperBinary({ stateDir, signal });
    const result = await runUiHelper(binPath, 'probe', { timeoutMs: 5_000, signal });
    return {
      ready: Boolean(result?.ok),
      reason: result?.ok ? undefined : result?.reason || 'route_unavailable',
      detail: String(result?.detail || (result?.ok ? 'Ready.' : 'Unavailable.')),
      accessibility: result?.accessibility,
      appRunning: result?.appRunning,
    };
  } catch (error) {
    return { ready: false, reason: error?.reason || 'setup_incomplete', detail: error.message };
  }
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether a Codex daemon thread's first user message matches the exact bridge dispatch envelope.
 * Accounts for Codex App's Markdown composer escaping the leading `<` as `\<`.
 */
export function firstUserMessageMatchesDispatch(thread, { fromApp = 'antigravity', fromId, messageId }) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const firstTurn = turns[0];
  const items = Array.isArray(firstTurn?.items) ? firstTurn.items : [];
  const firstUser = items.find(item => item?.type === 'userMessage');
  if (!firstUser || !Array.isArray(firstUser.content)) return false;
  const text = firstUser.content
    .filter(c => c?.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n');
  if (!text) return false;

  const pattern = new RegExp(
    `\\\\?<cross-session-message\\b[^>]*from-app="${escapeRegExp(fromApp)}"[^>]*from-id="${escapeRegExp(fromId)}"[^>]*message-id="${escapeRegExp(messageId)}"`,
  );
  return pattern.test(text);
}

/**
 * Scan recent daemon threads in `projectPath` to see if a dispatch with `messageId` already created a thread.
 * Used both after submission and before retrying/recovering uncertain dispatches to prevent duplicates.
 */
export async function findExistingCodexDispatch({
  projectPath,
  fromId,
  messageId,
  env = process.env,
  deps = {},
  signal,
  excludeIds = new Set(),
} = {}) {
  const open = deps.openDaemon ?? openDaemon;
  const list = deps.listDaemonThreads ?? listDaemonThreads;
  const read = deps.readDaemonThread ?? readDaemonThread;
  const targetCwd = path.resolve(projectPath);

  const conn = await open({ env, signal, timeoutMs: 5_000 });
  try {
    const candidates = await list(conn, { limit: 25, signal, timeoutMs: 5_000 });
    for (const item of candidates) {
      if (excludeIds.has(item.thread_id)) continue;
      if (!item.cwd || path.resolve(item.cwd) !== targetCwd) continue;
      const full = await read(conn, item.thread_id, { includeTurns: true, signal, timeoutMs: 5_000 });
      if (!full || full.source !== 'vscode' || full.ephemeral) continue;
      if (firstUserMessageMatchesDispatch(full, { fromApp: 'antigravity', fromId, messageId })) {
        return { id: normalizeCodexThreadId(full.id), thread: full };
      }
    }
    return null;
  } finally {
    conn.close();
  }
}

export async function prepareCodexAppNativeDispatch({ stateDir, projectId, env = process.env, signal } = {}) {
  const project = await resolveCodexLocalProject({ projectId, env, signal });
  const probe = await probeCodexAppNative({ stateDir, env, signal });
  if (!probe.ready) {
    throw failure(probe.detail, probe.reason || 'route_unavailable');
  }
  const binPath = await ensureUiHelperBinary({ stateDir, signal });
  return { project, binPath, stateDir, env };
}

export async function createCodexAppNativeThread(
  prepared,
  { text, messageId, fromId, signal, deps = {} } = {},
) {
  throwIfStopped(signal);
  const { project, binPath, env } = prepared;
  const open = deps.openDaemon ?? openDaemon;
  const list = deps.listDaemonThreads ?? listDaemonThreads;

  // Snapshot existing threads in this project before opening the deep link.
  const baselineIds = new Set();
  try {
    const conn = await open({ env, signal, timeoutMs: 5_000 });
    try {
      const existing = await list(conn, { limit: 30, signal, timeoutMs: 5_000 });
      for (const t of existing) {
        if (t.cwd && path.resolve(t.cwd) === path.resolve(project.path)) {
          baselineIds.add(t.thread_id);
        }
      }
    } finally {
      conn.close();
    }
  } catch (error) {
    throw failure(`Codex daemon must be reachable to verify native thread creation: ${error.message}`, 'route_unavailable');
  }

  // Open official `codex://threads/new` deep link to prefill the composer in the target project.
  const url = new URL('codex://threads/new');
  url.searchParams.set('cwd', project.path);
  url.searchParams.set('projectId', project.projectId);
  url.searchParams.set('prompt', text);

  beforeWrite(signal);
  try {
    await execFileAsync('/usr/bin/open', [url.toString()], { timeout: 6_000, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw failure(`Failed to open codex://threads/new deep link: ${error.stderr || error.message}`, 'route_unavailable');
  }

  // Verify project, GPT-6.2 Sol High, fast=false, and draft content before clicking Send.
  const uiResult = await runUiHelper(binPath, 'verify-and-submit', {
    input: JSON.stringify({
      projectName: project.name,
      expectedModelLabel: EXPECTED_MODEL_LABEL,
      expectedMessageId: messageId,
      expectedCallerId: fromId,
      timeoutMs: 8_000,
    }),
    timeoutMs: 15_000,
    signal,
  });

  if (!uiResult?.ok || !uiResult?.submitted) {
    const reason = uiResult?.reason || 'protocol_incompatible';
    const detail = String(uiResult?.detail || 'Codex App native UI verification blocked submission. Draft preserved.');
    throw failure(detail, reason, { draftPreserved: Boolean(uiResult?.draftPreserved) });
  }

  // Submission has crossed the write boundary: any subsequent lookup failure is `deliveryUnknown` (uncertain).
  const pollDeadline = Date.now() + 15_000;
  while (Date.now() < pollDeadline) {
    await delay(800);
    try {
      const match = await findExistingCodexDispatch({
        projectPath: project.path,
        fromId,
        messageId,
        env,
        deps,
        excludeIds: baselineIds,
      });
      if (match) {
        return { id: match.id, transport: 'codex-app-native' };
      }
    } catch {
      // Continue polling within the settlement window.
    }
  }

  throw markDeliveryUnknown(
    unconfirmedReply(
      'Codex App',
      'clicked Send after UI verification, but the new vscode thread was not observed in daemon within 15s',
    ),
  );
}
