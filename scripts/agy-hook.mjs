#!/usr/bin/env node
// Antigravity official lifecycle hook handler (SessionStart / PreToolUse / Stop).
// Registers the live local Antigravity endpoint into the shared host registry and records
// PreToolUse (toolName, argsHash) -> conversationId context without modifying tool arguments.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeBridgeToolName, recordCallerContext, registerAntigravityHost } from '../lib/state/host-registry.mjs';
import { resolveStateDir } from '../lib/state/state-dir.mjs';

const BRIDGE_TOOL_NAMES = new Set([
  'send_to_codex',
  'send_to_antigravity',
  'list_codex_threads',
  'list_antigravity_conversations',
  'list_deliveries',
  'bridge_doctor',
]);

function parseArgsObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to empty object.
    }
  }
  return {};
}

/**
 * Unwrap direct MCP tool calls and Antigravity lazy-MCP wrapper calls (`call_mcp_tool` / `mcp_tool`)
 * into `{ toolName, args }` for bridge tools, or return null for unrelated tools.
 */
export function unwrapBridgeToolCall(toolCall) {
  if (!toolCall || typeof toolCall.name !== 'string') return null;
  const rawName = toolCall.name.trim();
  const outerArgs = parseArgsObject(toolCall.args);

  if (/^(?:call_mcp_tool|mcp_tool)$/i.test(rawName)) {
    const serverName = String(
      outerArgs.ServerName ?? outerArgs.serverName ?? outerArgs.server_name ?? '',
    ).trim();
    if (serverName && !/antigravity-codex-bridge/i.test(serverName)) return null;

    const innerName = String(
      outerArgs.ToolName ?? outerArgs.toolName ?? outerArgs.tool_name ?? outerArgs.name ?? '',
    ).trim();
    const normalized = normalizeBridgeToolName(innerName);
    if (!BRIDGE_TOOL_NAMES.has(normalized)) return null;

    const innerArgs = outerArgs.Arguments ?? outerArgs.arguments ?? outerArgs.args;
    return { toolName: normalized, args: parseArgsObject(innerArgs) };
  }

  const normalized = normalizeBridgeToolName(rawName);
  if (!BRIDGE_TOOL_NAMES.has(normalized)) return null;
  return { toolName: normalized, args: outerArgs };
}

async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

export async function handleHookEvent({ event, stdinText, env = process.env } = {}) {
  let payload = {};
  if (stdinText) {
    try {
      payload = JSON.parse(stdinText);
    } catch {
      payload = {};
    }
  }

  const stateDir = resolveStateDir(env);
  const lsAddress = String(env.ANTIGRAVITY_LS_ADDRESS ?? '').trim();
  const csrfToken = String(env.ANTIGRAVITY_CSRF_TOKEN ?? '').trim();
  const agentapiBin = String(env.ANTIGRAVITY_AGENTAPI_EXE ?? '').trim() || undefined;

  if (lsAddress && csrfToken) {
    await registerAntigravityHost(stateDir, { lsAddress, csrfToken, agentapiBin }).catch(() => {});
  }

  if (event === 'pre-tool-use' || payload.hookEventName === 'PreToolUse') {
    const convId = String(payload.conversationId || env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
    const resolved = unwrapBridgeToolCall(payload.toolCall);
    if (convId && resolved) {
      try {
        recordCallerContext(stateDir, {
          toolName: resolved.toolName,
          args: resolved.args,
          conversationId: convId,
          cwd: String(payload.cwd || ''),
        });
      } catch {
        // Never block normal tool execution due to hook state issues.
      }
    }
    return { decision: 'allow' };
  }

  return {};
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const event = process.argv[2] || '';
  try {
    const stdinText = await readStdin();
    const result = await handleHookEvent({ event, stdinText });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Fail open for Antigravity lifecycle hooks so ordinary turns are never interrupted.
    process.stdout.write(event === 'pre-tool-use' ? '{"decision":"allow"}\n' : '{}\n');
  }
}
