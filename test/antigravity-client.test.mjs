import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getAntigravityConversation,
  listAntigravityConversations,
  probeAntigravityHost,
  sendToAntigravityConversation,
} from '../lib/transports/antigravity-client.mjs';

function startMockAntigravityServer(csrfToken) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.headers['x-antigravity-csrf-token'] !== csrfToken) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid csrf' }));
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.url === '/product.v1.ConversationService/ListConversations') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            conversations: [
              {
                id: 'conv-main-1',
                metadata: { projectId: 'proj-1', parentConversationId: '' },
                annotations: { title: 'Main Task', archived: false },
                state: { summary: 'Build bridge', runState: 'RUN_STATE_RUNNING', updateTime: '2026-11-26T14:00:00Z' },
              },
              {
                id: 'conv-sub-1',
                metadata: { projectId: 'proj-1', parentConversationId: 'conv-main-1' },
                annotations: { title: 'Subagent', archived: false },
                state: { summary: 'Research', runState: 'RUN_STATE_IDLE', updateTime: '2026-11-26T13:59:00Z' },
              },
              {
                id: 'conv-arch-1',
                metadata: { projectId: 'proj-1', parentConversationId: '' },
                annotations: { title: 'Old Archived', archived: true },
                state: { summary: 'Old', runState: 'RUN_STATE_IDLE', updateTime: '2026-11-25T10:00:00Z' },
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        if (body.conversationId === 'conv-main-1') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'conv-main-1',
              metadata: { projectId: 'proj-1', parentConversationId: '' },
              annotations: { title: 'Main Task', archived: false },
              state: { summary: 'Build bridge', runState: 'RUN_STATE_IDLE', updateTime: '2026-11-26T14:00:00Z' },
            }),
          );
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'not_found', message: 'conversation not found' }));
        return;
      }
      res.writeHead(404).end();
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, address: `127.0.0.1:${port}` });
    });
  });
}

test('antigravity-client probes, lists top-level conversations, and sends via agentapi', async () => {
  const token = 'secret-csrf-123';
  const { server, address } = await startMockAntigravityServer(token);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fake-bin-'));
  const fakeAgentapi = path.join(tmpDir, 'agentapi');
  const captureFile = path.join(tmpDir, 'captured.json');

  // Create executable fake agentapi script that captures args & env.
  fs.writeFileSync(
    fakeAgentapi,
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('missing-conv')) {
  process.stderr.write('conversation not found\\n');
  process.exit(1);
}
fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  args,
  addr: process.env.ANTIGRAVITY_LS_ADDRESS,
  token: process.env.ANTIGRAVITY_CSRF_TOKEN,
}));
process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`,
    { mode: 0o755 },
  );

  try {
    const host = { lsAddress: address, csrfToken: token, agentapiBin: fakeAgentapi };
    assert.equal(await probeAntigravityHost(host), true);

    // Default listing filters out subagents and archived sessions.
    const list = await listAntigravityConversations(host);
    assert.equal(list.length, 1);
    assert.equal(list[0].conversation_id, 'conv-main-1');

    // GetConversation returns metadata and 404 maps to target_unavailable.
    const conv = await getAntigravityConversation(host, 'conv-main-1');
    assert.equal(conv.run_state, 'RUN_STATE_IDLE');
    await assert.rejects(() => getAntigravityConversation(host, 'nope'), err => err.reason === 'target_unavailable');

    // Send message via fake agentapi
    const receipt = await sendToAntigravityConversation(host, {
      conversationId: 'conv-main-1',
      title: 'Codex Update',
      text: 'Hello Antigravity',
      env: { ...process.env, AGY_CODEX_BRIDGE_AGENTAPI_BIN: fakeAgentapi },
    });
    assert.equal(receipt.method, 'agentapi');
    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.deepEqual(captured.args, ['send-message', '--title=Codex Update', 'conv-main-1', 'Hello Antigravity']);
    assert.equal(captured.addr, address);
    assert.equal(captured.token, token);

    // Missing conversation maps cleanly to target_unavailable (pre-write failure)
    await assert.rejects(
      () =>
        sendToAntigravityConversation(host, {
          conversationId: 'missing-conv',
          text: 'Hi',
          env: { ...process.env, AGY_CODEX_BRIDGE_AGENTAPI_BIN: fakeAgentapi },
        }),
      err => err.reason === 'target_unavailable' && !err.deliveryUnknown,
    );
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
