import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBridgeService } from '../lib/service/bridge-service.mjs';
import { registerAntigravityHost } from '../lib/state/host-registry.mjs';
import { runMcpServer } from '../scripts/mcp.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUALIFIED_TOOL_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function createRpcClient(input, output) {
  let buf = '';
  const pending = new Map();
  output.on('data', chunk => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  let nextId = 1;
  return (method, params = {}) =>
    new Promise(resolve => {
      const id = nextId++;
      pending.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}

test('MCP server negotiates future protocol versions cleanly and completes two-way bridge calls without version checks', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-mcp-'));
  const sentToCodex = [];
  const sentToAgy = [];

  try {
    await registerAntigravityHost(stateDir, {
      lsAddress: '127.0.0.1:54321',
      csrfToken: 'tok-xyz',
      agentapiBin: '/fake/agentapi',
    });

    // 1. Antigravity-side MCP server instance
    const agyIn = new PassThrough();
    const agyOut = new PassThrough();
    const agyService = createBridgeService({
      stateDir,
      env: {
        AGY_CODEX_BRIDGE_HOST: 'antigravity',
        ANTIGRAVITY_CONVERSATION_ID: 'agy-conv-1',
      },
      deps: {
        openDaemon: async () => ({ close() {} }),
        listDaemonThreads: async () => [
          { thread_id: '0195c1b2-aaaa-bbbb-cccc-222222222222', title: 'Codex Backend', status: 'idle', cwd: '/repo', source: 'daemon' },
        ],
        sendToDaemonThread: async (_conn, opts) => {
          sentToCodex.push(opts);
          return { method: 'turn/start', turnId: 't-1' };
        },
        probeAntigravityHost: async () => true,
        resolveAgentapiCommand: () => ({ command: '/fake/agentapi', prefixArgs: [] }),
        resolveCodexExecutable: () => '/fake/codex',
        createLocalSocketChecker: () => () => false,
      },
    });
    const agyRun = runMcpServer({ input: agyIn, output: agyOut, env: { AGY_CODEX_BRIDGE_HOST: 'antigravity' }, service: agyService });
    const agyCall = createRpcClient(agyIn, agyOut);

    // Future protocolVersion must negotiate gracefully instead of erroring.
    const init = await agyCall('initialize', { protocolVersion: '2099-01-01', clientInfo: { name: 'test', version: '99.0' } });
    assert.ok(init.result.protocolVersion);
    assert.equal(init.result.serverInfo.name, 'antigravity-codex-bridge');

    const listedTools = await agyCall('tools/list');
    const names = listedTools.result.tools.map(t => t.name);
    assert.deepEqual(names, ['list_codex_threads', 'send_to_codex', 'list_deliveries', 'bridge_doctor']);

    const threadsRes = await agyCall('tools/call', { name: 'list_codex_threads', arguments: {} });
    assert.equal(threadsRes.result.structuredContent.threads.length, 1);

    const sendRes = await agyCall('tools/call', {
      name: 'send_to_codex',
      arguments: {
        thread_id: '0195c1b2-aaaa-bbbb-cccc-222222222222',
        message: 'API ready for frontend check',
        message_id: 'm-agy-1',
      },
    });
    assert.equal(sendRes.result.isError, undefined);
    assert.equal(sendRes.result.structuredContent.outcome.reason, 'submitted');
    assert.equal(sentToCodex.length, 1);
    assert.match(sentToCodex[0].text, /from-app="antigravity" from-id="agy-conv-1"/);

    // Doctor must never emit version_mismatch
    const doc = await agyCall('tools/call', { name: 'bridge_doctor', arguments: {} });
    assert.equal(doc.result.structuredContent.ready.two_way, true);
    assert.ok(!JSON.stringify(doc.result).includes('version_mismatch'));

    const missingCaller = createBridgeService({
      stateDir,
      env: { AGY_CODEX_BRIDGE_HOST: 'antigravity' },
      deps: {
        probeAntigravityHost: async () => true,
        resolveAgentapiCommand: () => ({ command: '/fake/agentapi' }),
        resolveCodexExecutable: () => '/fake/codex',
        openDaemon: async () => ({ close() {} }),
        listDaemonThreads: async () => [],
      },
    });
    const missingCallerReport = await missingCaller.executeTool('bridge_doctor');
    assert.deepEqual(missingCallerReport.ready, {
      antigravity_inbound: true,
      codex_inbound: true,
      two_way: false,
    });
    assert.equal(missingCallerReport.checks.find(check => check.check === 'caller_identity').status, 'warning');

    agyIn.end();
    await agyRun;

    // 2. Codex-side MCP server instance replying back to Antigravity
    const cdxIn = new PassThrough();
    const cdxOut = new PassThrough();
    const cdxService = createBridgeService({
      stateDir,
      env: { AGY_CODEX_BRIDGE_HOST: 'codex' },
      deps: {
        probeAntigravityHost: async () => true,
        listAntigravityConversations: async () => [
          {
            conversation_id: 'agy-conv-1',
            title: 'Frontend Session',
            summary: 'Check UI',
            run_state: 'RUN_STATE_IDLE',
            project_id: 'p1',
            parent_conversation_id: '',
            archived: false,
            update_time: '2026-11-26T14:00:00Z',
            host_address: '127.0.0.1:54321',
          },
        ],
        getAntigravityConversation: async (_host, id) => ({
          conversation_id: id,
          title: 'Frontend Session',
          summary: 'Check UI',
          run_state: 'RUN_STATE_IDLE',
          project_id: 'p1',
          parent_conversation_id: '',
          archived: false,
          update_time: '2026-11-26T14:00:00Z',
          host_address: '127.0.0.1:54321',
        }),
        sendToAntigravityConversation: async (_host, opts) => {
          sentToAgy.push(opts);
          return { method: 'agentapi', receipt: { ok: true } };
        },
        resolveAgentapiCommand: () => ({ command: '/fake/agentapi', prefixArgs: [] }),
        resolveCodexExecutable: () => '/fake/codex',
        createLocalSocketChecker: () => () => false,
      },
    });
    const cdxRun = runMcpServer({ input: cdxIn, output: cdxOut, env: { AGY_CODEX_BRIDGE_HOST: 'codex' }, service: cdxService });
    const cdxCall = createRpcClient(cdxIn, cdxOut);

    const cdxTools = await cdxCall('tools/list');
    assert.deepEqual(
      cdxTools.result.tools.map(t => t.name),
      ['list_antigravity_conversations', 'send_to_antigravity', 'list_deliveries', 'bridge_doctor'],
    );

    const replyRes = await cdxCall('tools/call', {
      name: 'send_to_antigravity',
      arguments: {
        conversation_id: 'agy-conv-1',
        message: 'Verified on frontend, looks good!',
        message_id: 'm-cdx-1',
      },
      _meta: {
        'x-codex-turn-metadata': JSON.stringify({ thread_id: '0195c1b2-aaaa-bbbb-cccc-222222222222' }),
      },
    });
    assert.equal(replyRes.result.isError, undefined);
    assert.equal(replyRes.result.structuredContent.outcome.reason, 'submitted');
    assert.equal(sentToAgy.length, 1);
    assert.equal(sentToAgy[0].conversationId, 'agy-conv-1');
    assert.match(sentToAgy[0].text, /from-app="codex" from-id="0195c1b2-aaaa-bbbb-cccc-222222222222"/);

    cdxIn.end();
    await cdxRun;
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('MCP server drains in-flight async tool calls before exiting on stdin EOF', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];
  output.on('data', chunk => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      responses.push(JSON.parse(line));
    }
  });
  const fakeService = {
    async refreshOwnRegistration() {},
    async executeTool(name) {
      await new Promise(r => setTimeout(r, 40));
      return { ok: true, tool: name };
    },
  };
  const run = runMcpServer({ input, output, env: { AGY_CODEX_BRIDGE_HOST: 'codex' }, service: fakeService });
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bridge_doctor', arguments: {} } })}\n`);
  await run;
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 7);
  assert.equal(responses[0].result.structuredContent.ok, true);
});

test('qualified MCP tool names satisfy 64-char host identifier limits for Antigravity and Codex', async () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'plugin.json'), 'utf8'));
  const agyMcp = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'mcp_config.json'), 'utf8'));
  const codexPlugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));

  const listToolsFor = async hostApp => {
    const input = new PassThrough();
    const output = new PassThrough();
    const run = runMcpServer({
      input,
      output,
      env: { AGY_CODEX_BRIDGE_HOST: hostApp },
      service: { async refreshOwnRegistration() {} },
    });
    const call = createRpcClient(input, output);
    const res = await call('tools/list');
    input.end();
    await run;
    return res.result.tools;
  };

  const agyTools = await listToolsFor('antigravity');
  const agyServers = Object.keys(agyMcp.mcpServers);
  assert.ok(agyServers.length > 0);
  for (const serverKey of agyServers) {
    for (const tool of agyTools) {
      const qualified = `mcp_${plugin.name}_${serverKey}_${tool.name}`;
      assert.match(
        qualified,
        QUALIFIED_TOOL_RE,
        `Antigravity tool "${qualified}" (${qualified.length} chars) exceeds ^[a-zA-Z0-9_-]{1,64}$; shorten mcp_config.json server key or tool name.`,
      );
    }
  }

  const codexTools = await listToolsFor('codex');
  for (const serverKey of Object.keys(codexPlugin.mcpServers)) {
    for (const tool of codexTools) {
      const qualified = `mcp__${serverKey}__${tool.name}`;
      assert.match(
        qualified,
        QUALIFIED_TOOL_RE,
        `Codex tool "${qualified}" (${qualified.length} chars) exceeds ^[a-zA-Z0-9_-]{1,64}$; shorten server key or tool name.`,
      );
    }
  }
});
