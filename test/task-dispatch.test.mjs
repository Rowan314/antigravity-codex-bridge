import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { failure, unconfirmedReply } from '../lib/core/outcome.mjs';
import { createBridgeService } from '../lib/service/bridge-service.mjs';
import { firstUserMessageMatchesDispatch } from '../lib/transports/codex-app-native.mjs';
import { registerAntigravityHost, registerCodexDesktopHost } from '../lib/state/host-registry.mjs';
import { unwrapBridgeToolCall } from '../scripts/agy-hook.mjs';

const codex = '0195c1b2-aaaa-bbbb-cccc-1234567890ab';
const agy = 'the-antigravity-caller';
const task = {
  message_id: 'dispatch-1',
  title: 'Validate the bridge',
  project_id: 'project-1',
  message: 'Reply to the sender.',
  authorization_ref: 'Rowan confirmed this smoke test in the source conversation.',
};

async function fixture(t, overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-dispatch-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  await registerAntigravityHost(stateDir, { lsAddress: 'localhost:12345', csrfToken: 'test-token' });
  await registerCodexDesktopHost(stateDir, {
    pipePath: process.platform === 'win32' ? '\\\\.\\pipe\\agy-dispatch' : '/tmp/agy-dispatch.sock',
    contextThreadId: codex,
  });
  const deps = {
    openDaemon: async () => ({ close() {} }),
    readDaemonThread: async () => ({ cwd: '/repo', source: 'vscode', ephemeral: false }),
    probeAntigravityHost: async () => true,
    listAntigravityConversations: async () => [{ project_id: 'project-1' }],
    getAntigravityConversation: async () => ({ project_id: 'project-1' }),
    resolveAgentapiCommand: () => ({ command: '/fake/agentapi' }),
    prepareCodexAppNativeDispatch: null,
    createCodexAppNativeThread: null,
    findExistingCodexDispatch: null,
    probeCodexAppNative: async () => ({ ready: false, reason: 'route_unavailable', detail: 'disabled in unit fixture' }),
    prepareCodexDesktopDispatch: async () => ({ project: { path: '/repo' } }),
    ...overrides,
  };
  const service = app => createBridgeService({
    stateDir, deps, env: { AGY_CODEX_BRIDGE_HOST: app, CODEX_THREAD_ID: codex, ANTIGRAVITY_CONVERSATION_ID: agy },
  });
  return { codexService: service('codex'), agyService: service('antigravity') };
}

test('Codex dispatch journals the verified new Antigravity conversation and replays the receipt', async t => {
  let creates = 0;
  const { codexService } = await fixture(t, {
    createAntigravityConversation: async (_host, { projectId, text, title }) => {
      creates++;
      assert.equal(projectId, task.project_id);
      assert.equal(title, task.title);
      assert.match(text, new RegExp(`from-app="codex" from-id="${codex}"`));
      assert.match(text, /Authorization reference/);
      assert.match(text, /Reply to the sender/);
      return { id: 'agy-target', transport: 'agentapi' };
    },
  });
  const first = await codexService.executeTool('dispatch_to_antigravity', task);
  const retry = await codexService.executeTool('dispatch_to_antigravity', task);
  assert.equal(first.outcome.reason, 'submitted');
  assert.equal(retry.outcome.reason, 'already_submitted');
  assert.equal(first.delivery.to.id, 'agy-target');
  assert.deepEqual(retry.delivery, first.delivery);
  assert.equal(creates, 1);
  await assert.rejects(codexService.executeTool('dispatch_to_antigravity', { ...task, title: 'another title' }),
    { reason: 'id_conflict' });
  const log = await codexService.executeTool('list_deliveries', { message_id: task.message_id });
  assert.equal(log.deliveries[0].to.id, 'agy-target');
});

test('Antigravity dispatch invokes only native Codex creation and keeps the verified reply address', async t => {
  const { agyService } = await fixture(t, {
    createCodexDesktopThread: async (_prepared, { text }) => {
      assert.match(text, new RegExp(`from-app="antigravity" from-id="${agy}"`));
      assert.match(text, /send_to_antigravity\(conversation_id=/);
      return { id: 'codex-target', transport: 'desktop' };
    },
  });
  const result = await agyService.executeTool('dispatch_to_codex', task);
  assert.equal(result.delivery.to.id, 'codex-target');
  assert.deepEqual(unwrapBridgeToolCall({ name: 'mcp_antigravity-codex-bridge_bridge_dispatch_to_codex', args: task }),
    { toolName: 'dispatch_to_codex', args: task });
});

test('dispatch blocks missing authorization, wrong projects, subagents, and missing native routes before creation', async t => {
  const { agyService, codexService } = await fixture(t, {
    prepareCodexDesktopDispatch: async () => { throw failure('native unavailable', 'route_unavailable'); },
    createCodexDesktopThread: async () => assert.fail('must not create'),
    createAntigravityConversation: async () => assert.fail('must not create'),
    getAntigravityConversation: async () => ({ parent_conversation_id: 'parent' }),
  });
  await assert.rejects(codexService.executeTool('dispatch_to_antigravity', { ...task, authorization_ref: '' }),
    { reason: 'invalid_argument' });
  await assert.rejects(codexService.executeTool('dispatch_to_antigravity', { ...task, project_id: 'wrong' }),
    { reason: 'target_unavailable' });
  await assert.rejects(agyService.executeTool('dispatch_to_codex', task), { reason: 'caller_unverified' });

  const main = await fixture(t, { prepareCodexDesktopDispatch: async () => {
    throw failure('native unavailable', 'route_unavailable');
  } });
  await assert.rejects(main.agyService.executeTool('dispatch_to_codex', task), { reason: 'route_unavailable' });
});

test('uncertain native creation blocks blind retries and retains the ID when verification fails', async t => {
  for (const recordedId of [null, 'new-conversation']) {
    let creates = 0;
    const { codexService } = await fixture(t, {
      createAntigravityConversation: async () => {
        creates++;
        if (!recordedId) throw unconfirmedReply('Antigravity');
        return { id: recordedId, transport: 'agentapi' };
      },
      getAntigravityConversation: async () => ({ project_id: 'unexpected-project' }),
    });
    await assert.rejects(codexService.executeTool('dispatch_to_antigravity', task),
      { reason: 'delivery_unconfirmed' });
    const log = await codexService.executeTool('list_deliveries', { message_id: task.message_id });
    assert.equal(log.deliveries[0].status, 'uncertain');
    assert.equal(log.deliveries[0].to.id, recordedId);
    await assert.rejects(codexService.executeTool('dispatch_to_antigravity', { ...task, retry_failed: true }),
      { reason: 'prior_uncertain' });
    assert.equal(creates, 1);
  }
});

test('a concurrent dispatch cannot create another conversation with the same ID', async t => {
  let release;
  let entered;
  const enteredCreate = new Promise(resolve => { entered = resolve; });
  const waitForRelease = new Promise(resolve => { release = resolve; });
  const { codexService } = await fixture(t, {
    createAntigravityConversation: async () => {
      entered();
      await waitForRelease;
      return { id: 'agy-target', transport: 'agentapi' };
    },
  });
  const first = codexService.executeTool('dispatch_to_antigravity', task);
  await enteredCreate;
  try {
    await assert.rejects(codexService.executeTool('dispatch_to_antigravity', task), { reason: 'in_flight' });
  } finally {
    release();
    await first;
  }
});

test('firstUserMessageMatchesDispatch matches both raw and Codex-escaped envelope headers', () => {
  const escapedThread = {
    turns: [{
      items: [{
        type: 'userMessage',
        content: [{
          type: 'text',
          text: '\\<cross-session-message from-app="antigravity" from-id="agy-1" message-id="disp-99">\nbody',
        }],
      }],
    }],
  };
  assert.equal(firstUserMessageMatchesDispatch(escapedThread, { fromApp: 'antigravity', fromId: 'agy-1', messageId: 'disp-99' }), true);
  assert.equal(firstUserMessageMatchesDispatch(escapedThread, { fromApp: 'antigravity', fromId: 'agy-1', messageId: 'disp-00' }), false);
});

test('Antigravity dispatch uses native Codex App path and reconciles uncertain retries by message_id without duplicating', async t => {
  let creates = 0;
  let existingMatch = null;
  const { agyService } = await fixture(t, {
    prepareCodexAppNativeDispatch: async () => ({ project: { projectId: 'project-1', name: 'demo', path: '/repo' } }),
    resolveCodexLocalProject: async () => ({ projectId: 'project-1', name: 'demo', path: '/repo' }),
    createCodexAppNativeThread: async (_prepared, { text, messageId, fromId }) => {
      creates++;
      assert.equal(messageId, task.message_id);
      assert.equal(fromId, agy);
      assert.match(text, /Authorization reference/);
      throw unconfirmedReply('Codex App', 'timed out waiting for daemon');
    },
    findExistingCodexDispatch: async () => existingMatch,
  });

  // 1. First attempt crosses write boundary then times out -> uncertain
  await assert.rejects(agyService.executeTool('dispatch_to_codex', task), { reason: 'delivery_unconfirmed' });
  assert.equal(creates, 1);

  // 2. When the thread actually appeared with matching message-id, retrying reconciles without calling create again
  existingMatch = { id: 'codex-native-1' };
  const reconciled = await agyService.executeTool('dispatch_to_codex', task);
  assert.equal(reconciled.outcome.reason, 'already_submitted');
  assert.equal(reconciled.delivery.to.id, 'codex-native-1');
  assert.equal(creates, 1);
});

test('bridge_doctor separately reports existing_sessions and native_dispatch readiness', async t => {
  const { agyService } = await fixture(t, {
    listDaemonThreads: async () => [],
    resolveCodexExecutable: () => '/usr/local/bin/codex',
    probeCodexAppNative: async () => ({ ready: false, reason: 'access_denied', detail: 'Accessibility denied.' }),
  });
  const doc = await agyService.executeTool('bridge_doctor', {});
  assert.equal(doc.existing_sessions.two_way, true);
  assert.equal(doc.native_dispatch.to_antigravity, true);
  assert.equal(doc.native_dispatch.to_codex, false);
  assert.match(doc.native_dispatch.to_codex_detail, /Accessibility denied/);
});

