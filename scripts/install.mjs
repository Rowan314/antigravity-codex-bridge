#!/usr/bin/env node
// Cross-client installer/uninstaller for Antigravity–Codex Bridge.
// Links/validates the Antigravity plugin and registers the MCP server + skill in Codex.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexExecutable } from '../lib/transports/codex-binary.mjs';

const PLUGIN_NAME = 'antigravity-codex-bridge';
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseFlags(argv) {
  const flags = new Set(argv);
  const onlyAgy = flags.has('--antigravity');
  const onlyCodex = flags.has('--codex');
  return {
    antigravity: onlyAgy || !onlyCodex,
    codex: onlyCodex || !onlyAgy,
    uninstall: flags.has('--uninstall'),
    dryRun: flags.has('--dry-run'),
  };
}

function runSync(cmd, args, { allowFail = false } = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout: out.trim(), stderr: '' };
  } catch (error) {
    if (!allowFail) throw error;
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
    };
  }
}

function installAntigravity({ dryRun, uninstall }) {
  const home = os.homedir();
  const pluginsDir = path.join(home, '.gemini', 'config', 'plugins');
  const targetDir = path.join(pluginsDir, PLUGIN_NAME);
  const isInPlace = fs.existsSync(targetDir) && fs.realpathSync(targetDir) === fs.realpathSync(ROOT_DIR);

  if (uninstall) {
    if (isInPlace) {
      console.log(`[antigravity] Plugin source lives directly at ${targetDir}; skip deleting source directory.`);
      return;
    }
    if (fs.existsSync(targetDir)) {
      if (dryRun) console.log(`[antigravity][dry-run] Would remove link ${targetDir}`);
      else {
        fs.rmSync(targetDir, { recursive: true, force: true });
        console.log(`[antigravity] Removed ${targetDir}`);
      }
    } else {
      console.log('[antigravity] Not installed.');
    }
    return;
  }

  if (!isInPlace) {
    if (dryRun) {
      console.log(`[antigravity][dry-run] Would symlink ${targetDir} -> ${ROOT_DIR}`);
    } else {
      fs.mkdirSync(pluginsDir, { recursive: true });
      if (fs.existsSync(targetDir)) {
        throw new Error(`Refusing to overwrite existing directory at ${targetDir}`);
      }
      fs.symlinkSync(ROOT_DIR, targetDir, 'dir');
      console.log(`[antigravity] Linked ${targetDir} -> ${ROOT_DIR}`);
    }
  } else {
    console.log(`[antigravity] Already placed in default plugins directory: ${targetDir}`);
  }

  const agyBin = path.join(home, '.local', 'bin', 'agy');
  const agyCmd = fs.existsSync(agyBin) ? agyBin : 'agy';
  const check = runSync(agyCmd, ['plugin', 'validate', ROOT_DIR], { allowFail: true });
  if (check.ok) {
    console.log('[antigravity] `agy plugin validate` passed with 0 errors.');
  } else {
    console.log(`[antigravity] Validation note: ${check.stderr || check.stdout}`);
  }
}

function installCodex({ dryRun, uninstall }) {
  const codexBin = resolveCodexExecutable();
  if (!codexBin) {
    console.log('[codex] Codex CLI not found on PATH; skipping Codex registration.');
    return;
  }

  const mcpScript = path.join(ROOT_DIR, 'scripts', 'mcp.mjs');
  const runWrapper = path.join(ROOT_DIR, 'scripts', 'run-mcp.sh');
  const launchCmd = process.platform === 'win32' ? ['node', mcpScript] : ['/bin/sh', runWrapper];

  if (uninstall) {
    if (dryRun) {
      console.log(`[codex][dry-run] Would run: ${codexBin} mcp remove ${PLUGIN_NAME}`);
    } else {
      const res = runSync(codexBin, ['mcp', 'remove', PLUGIN_NAME], { allowFail: true });
      console.log(res.ok ? `[codex] Removed MCP server ${PLUGIN_NAME}.` : `[codex] ${res.stderr || 'Not registered.'}`);
    }
    return;
  }

  // Register MCP server directly via official `codex mcp add` without pinning a Node version path.
  const addArgs = [
    'mcp',
    'add',
    PLUGIN_NAME,
    '--env',
    'AGY_CODEX_BRIDGE_HOST=codex',
    '--',
    ...launchCmd,
  ];
  if (dryRun) {
    console.log(`[codex][dry-run] Would run: ${codexBin} ${addArgs.join(' ')}`);
  } else {
    // Remove stale entry first so updates stay idempotent.
    runSync(codexBin, ['mcp', 'remove', PLUGIN_NAME], { allowFail: true });
    const res = runSync(codexBin, addArgs, { allowFail: true });
    if (res.ok) {
      console.log(`[codex] Registered MCP server "${PLUGIN_NAME}" via \`codex mcp add\`.`);
    } else {
      console.error(`[codex] Failed to register MCP server: ${res.stderr || res.stdout}`);
      process.exitCode = 1;
    }
  }

  // Also link the bridge skill into global skills dir (~/.agent/skills/antigravity-codex-bridge) if absent,
  // which ~/.codex/skills and ~/.gemini/config/skills already read via symlink.
  const globalSkillsDir = path.join(os.homedir(), '.agent', 'skills');
  const skillLink = path.join(globalSkillsDir, PLUGIN_NAME);
  const skillSource = path.join(ROOT_DIR, 'skills', 'bridge');
  if (fs.existsSync(globalSkillsDir) && !fs.existsSync(skillLink)) {
    if (dryRun) {
      console.log(`[codex][dry-run] Would symlink skill ${skillLink} -> ${skillSource}`);
    } else {
      fs.symlinkSync(skillSource, skillLink, 'dir');
      console.log(`[codex] Linked bridge skill ${skillLink} -> ${skillSource}`);
    }
  }
}

const opts = parseFlags(process.argv.slice(2));
if (opts.antigravity) installAntigravity(opts);
if (opts.codex) installCodex(opts);
