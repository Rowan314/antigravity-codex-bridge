import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveAntigravityCaller, resolveCodexCaller } from '../lib/service/caller-identity.mjs';
import { recordCallerContext } from '../lib/state/host-registry.mjs';
import { handleHookEvent } from '../scripts/agy-hook.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-id-'));
}

test('resolveCodexCaller extracts thread_id from metadata and rejects conflicts', () => {
  const caller = resolveCodexCaller({
    metadata: {
      'x-codex-turn-metadata': JSON.stringify({ thread_id: '0195C1B2-AAAA-BBBB-CCCC-1234567890AB' }),
    },
    env: {},
  });
  assert.deepEqual(caller, { app: 'codex', id: '0195c1b2-aaaa-bbbb-cccc-1234567890ab' });

  assert.throws(
    () =>
      resolveCodexCaller({
        metadata: {
          'openai/threadId': '0195c1b2-aaaa-bbbb-cccc-1234567890ab',
          thread_id: '0195c1b2-aaaa-bbbb-cccc-000000000000',
        },
        env: {},
      }),
    err => err.reason === 'caller_unverified',
  );
});

test('resolveAntigravityCaller matches PreToolUse hook context cleanly across concurrent sessions', async () => {
  const stateDir = makeTempDir();
  try {
    // Simulate Antigravity PreToolUse hooks from two different conversations with different args
    const hook1 = await handleHookEvent({
      event: 'pre-tool-use',
      env: {
        AGY_CODEX_BRIDGE_STATE_DIR: stateDir,
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:51234',
        ANTIGRAVITY_CSRF_TOKEN: 'tok-abc',
      },
      stdinText: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv-alpha',
        toolCall: {
          name: 'mcp_antigravity-codex-bridge_bridge_send_to_codex',
          args: { thread_id: 't-1', message: 'hello from alpha' },
        },
      }),
    });
    assert.deepEqual(hook1, { decision: 'allow' });

    await handleHookEvent({
      event: 'pre-tool-use',
      env: { AGY_CODEX_BRIDGE_STATE_DIR: stateDir },
      stdinText: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv-beta',
        toolCall: {
          name: 'send_to_codex',
          args: { message: 'hello from beta', thread_id: 't-2' },
        },
      }),
    });

    // Keys in different order must produce the same canonical hash and bind the exact caller.
    const c1 = resolveAntigravityCaller({
      stateDir,
      toolName: 'send_to_codex',
      args: { message: 'hello from alpha', thread_id: 't-1' },
      env: {},
    });
    assert.equal(c1.id, 'conv-alpha');
    assert.equal(c1.source, 'hook');

    const c2 = resolveAntigravityCaller({
      stateDir,
      toolName: 'send_to_codex',
      args: { thread_id: 't-2', message: 'hello from beta' },
      env: {},
    });
    assert.equal(c2.id, 'conv-beta');

    // Identical concurrent args from two sessions must raise caller_ambiguous instead of guessing.
    recordCallerContext(stateDir, {
      toolName: 'send_to_codex',
      args: { thread_id: 't-9', message: 'same' },
      conversationId: 'conv-1',
    });
    recordCallerContext(stateDir, {
      toolName: 'send_to_codex',
      args: { thread_id: 't-9', message: 'same' },
      conversationId: 'conv-2',
    });
    assert.throws(
      () =>
        resolveAntigravityCaller({
          stateDir,
          toolName: 'send_to_codex',
          args: { thread_id: 't-9', message: 'same' },
          env: {},
        }),
      err => err.reason === 'caller_ambiguous',
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('PreToolUse hook unwraps lazy call_mcp_tool / mcp_tool calls and ignores unrelated servers', async () => {
  const stateDir = makeTempDir();
  try {
    // 1. Lazy call_mcp_tool with PascalCase fields and object Arguments
    await handleHookEvent({
      event: 'pre-tool-use',
      env: { AGY_CODEX_BRIDGE_STATE_DIR: stateDir },
      stdinText: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv-lazy-1',
        toolCall: {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'antigravity-codex-bridge_bridge',
            ToolName: 'send_to_codex',
            Arguments: { message: 'hello lazy', thread_id: 't-lazy' },
          },
        },
      }),
    });

    const c1 = resolveAntigravityCaller({
      stateDir,
      toolName: 'send_to_codex',
      args: { thread_id: 't-lazy', message: 'hello lazy' },
      env: {},
    });
    assert.equal(c1.id, 'conv-lazy-1');
    assert.equal(c1.source, 'hook');

    // 2. mcp_tool with camelCase fields and JSON-string arguments
    await handleHookEvent({
      event: 'pre-tool-use',
      env: { AGY_CODEX_BRIDGE_STATE_DIR: stateDir },
      stdinText: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv-lazy-2',
        toolCall: {
          name: 'mcp_tool',
          args: {
            serverName: 'antigravity-codex-bridge_bridge',
            toolName: 'list_deliveries',
            arguments: JSON.stringify({ limit: 5 }),
          },
        },
      }),
    });

    const c2 = resolveAntigravityCaller({
      stateDir,
      toolName: 'list_deliveries',
      args: { limit: 5 },
      env: {},
    });
    assert.equal(c2.id, 'conv-lazy-2');

    // 3. Unrelated MCP server must not record caller context
    await handleHookEvent({
      event: 'pre-tool-use',
      env: { AGY_CODEX_BRIDGE_STATE_DIR: stateDir },
      stdinText: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv-other',
        toolCall: {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'other_mcp_server',
            ToolName: 'send_to_codex',
            Arguments: { thread_id: 't-x', message: 'nope' },
          },
        },
      }),
    });

    assert.throws(
      () =>
        resolveAntigravityCaller({
          stateDir,
          toolName: 'send_to_codex',
          args: { thread_id: 't-x', message: 'nope' },
          env: {},
        }),
      err => err.reason === 'caller_unverified',
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
