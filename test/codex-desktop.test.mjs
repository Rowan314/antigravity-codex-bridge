import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { markDeliveryUnknown } from '../lib/core/outcome.mjs';
import { createBridgeService } from '../lib/service/bridge-service.mjs';
import { dispatchMessageToCodex } from '../lib/service/codex-router.mjs';
import { registerCodexDesktopHost } from '../lib/state/host-registry.mjs';
import { ThreadNotLoadedError } from '../lib/transports/codex-daemon.mjs';
import {
  createCodexDesktopThread, listDesktopThreads, prepareCodexDesktopDispatch, sendToDesktopThread,
} from '../lib/transports/codex-desktop.mjs';

function encodeFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

test('Desktop readiness requires a protocol response and auto routing preserves uncertain submissions', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-route-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const pipePath = process.platform === 'win32' ? '//./pipe/bridge-test' : '/tmp/bridge-test.sock';
  await registerCodexDesktopHost(stateDir, { pipePath, contextThreadId: 'desktop-caller' });
  const deps = {
    createLocalSocketChecker: () => () => true,
    listDesktopThreads: async () => { throw new Error('Socket closed without a reply'); },
    openDaemon: async () => { throw new Error('No daemon'); },
    resolveCodexExecutable: () => null,
  };
  const report = await createBridgeService({ stateDir, env: { AGY_CODEX_BRIDGE_HOST: 'antigravity' }, deps })
    .executeTool('bridge_doctor');
  assert.equal(report.ready.codex_inbound, false);
  assert.deepEqual(report.checks.find(check => check.check === 'codex_desktop'), {
    check: 'codex_desktop', status: 'warning', detail: 'Socket closed without a reply',
  });

  let queued = 0;
  const dispatch = {
    stateDir, threadId: 'test-thread', transport: 'auto',
    deps: {
      ...deps,
      openDaemon: async () => ({ close() {} }),
      sendToDaemonThread: async () => { throw new ThreadNotLoadedError('Not loaded'); },
      queueToCodexThread: async () => { queued++; },
    },
  };
  assert.equal(await dispatchMessageToCodex(dispatch), 'queue');
  const uncertain = markDeliveryUnknown(new Error('Closed after sending'));
  dispatch.deps.listDesktopThreads = async () => [{ thread_id: 'test-thread' }];
  dispatch.deps.sendToDesktopThread = async () => { throw uncertain; };
  await assert.rejects(dispatchMessageToCodex(dispatch), error => error === uncertain);
  assert.equal(queued, 1);
});

test('codex-desktop discovers capabilities via tools/list and sends over Unix socket', async () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-sock-'));
  const sockPath = path.join(dir, 'app-tools.sock');
  let lastSent = null;

  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const len = pending.readUInt32LE(0);
        if (pending.length < 4 + len) return;
        const msg = JSON.parse(pending.subarray(4, 4 + len).toString('utf8'));
        pending = pending.subarray(4 + len);
        if (msg.method === 'tools/list') {
          socket.write(
            encodeFrame({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  { name: 'list_threads', namespace: 'codex_app' },
                  {
                    name: 'send_message_to_thread',
                    namespace: 'codex_app',
                    inputSchema: {
                      properties: {
                        threadId: { type: 'string' },
                        prompt: { type: 'string' },
                        hostId: { type: 'string' },
                      },
                    },
                  },
                ],
              },
            }),
          );
        } else if (msg.method === 'tools/call' && msg.params.tool === 'list_threads') {
          socket.write(
            encodeFrame({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                success: true,
                contentItems: [
                  {
                    type: 'inputText',
                    text: JSON.stringify({
                      threads: [
                        { id: '0195c1b2-aaaa-bbbb-cccc-111111111111', kind: 'codex', title: 'Desktop Chat', status: 'idle', cwd: '/proj' },
                      ],
                    }),
                  },
                ],
              },
            }),
          );
        } else if (msg.method === 'tools/call' && msg.params.tool === 'send_message_to_thread') {
          lastSent = msg.params.arguments;
          socket.write(
            encodeFrame({
              jsonrpc: '2.0',
              id: msg.id,
              result: { success: true, contentItems: [] },
            }),
          );
        }
      }
    });
  });

  await new Promise(resolve => server.listen(sockPath, resolve));
  try {
    const threads = await listDesktopThreads({ pipePath: sockPath, contextThreadId: 'ctx-1', limit: 10 });
    assert.equal(threads.length, 1);
    assert.equal(threads[0].title, 'Desktop Chat');
    assert.equal(threads[0].source, 'desktop');

    const res = await sendToDesktopThread({
      pipePath: sockPath,
      contextThreadId: 'ctx-1',
      threadId: '0195c1b2-aaaa-bbbb-cccc-111111111111',
      text: 'Hello Desktop',
    });
    assert.equal(res.method, 'desktop');
    assert.deepEqual(lastSent, {
      threadId: '0195c1b2-aaaa-bbbb-cccc-111111111111',
      prompt: 'Hello Desktop',
      hostId: 'local',
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native Codex dispatch checks project and speed before creating and requires a local receipt', async t => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-dispatch-'));
  const pipePath = path.join(dir, 'app-tools.sock');
  const project = { projectId: 'local-project', projectKind: 'local', hostId: 'local', path: '/repo' };
  let requested = null;
  let supportsSpeed = true;
  let returnsReceipt = true;
  const server = net.createServer(socket => {
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
      const msg = JSON.parse(buf.subarray(4).toString('utf8'));
      let result;
      if (msg.method === 'tools/list') {
        const properties = {
          target: {}, title: {}, prompt: {}, model: {}, thinking: {},
          ...(supportsSpeed ? { fast: { type: 'boolean' } } : {}),
        };
        result = { tools: [
          { name: 'list_projects', namespace: 'codex_app' },
          { name: 'create_thread', namespace: 'codex_app', inputSchema: { properties } },
        ] };
      } else {
        const listing = msg.params.tool === 'list_projects';
        if (!listing) requested = msg.params;
        const payload = listing ? { projects: [project] }
          : returnsReceipt ? { threadId: 'new-1', hostId: 'local' } : { clientThreadId: 'queued-1' };
        result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(payload) }] };
      }
      socket.end(encodeFrame({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise(resolve => server.listen(pipePath, resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = { pipePath, contextThreadId: 'ctx-1' };
  await assert.rejects(prepareCodexDesktopDispatch(host, { projectId: 'incorrect' }),
    { reason: 'target_unavailable' });
  assert.equal(requested, null);
  const prepared = await prepareCodexDesktopDispatch(host, { projectId: project.projectId });
  const opts = { title: 'Test', text: 'Authorized first task', messageId: 'dispatch-1' };
  assert.deepEqual(await createCodexDesktopThread(prepared, opts), { id: 'new-1', transport: 'desktop' });
  assert.equal(requested.callerSource, 'antigravity');
  assert.deepEqual(requested.arguments, {
    title: 'Test',
    prompt: 'Authorized first task',
    target: { type: 'project', projectId: project.projectId, environment: { type: 'local' } },
    model: 'gpt-6.2-sol',
    thinking: 'high',
    fast: false,
  });
  returnsReceipt = false;
  await assert.rejects(createCodexDesktopThread(prepared, opts), { reason: 'delivery_unconfirmed' });
  supportsSpeed = false;
  await assert.rejects(prepareCodexDesktopDispatch(host, { projectId: project.projectId }),
    { reason: 'protocol_incompatible' });
});
