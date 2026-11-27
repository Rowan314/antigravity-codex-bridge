import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ThreadNotLoadedError,
  listDaemonThreads,
  openDaemon,
  queueToCodexThread,
  sendToDaemonThread,
} from '../lib/transports/codex-daemon.mjs';

function writeFakeCodexProxy(dir) {
  const script = path.join(dir, 'fake-codex-proxy.mjs');
  const code = `import crypto from 'node:crypto';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const mode = process.env.FAKE_PROXY_MODE || 'normal';

function sendWsText(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  }
  process.stdout.write(Buffer.concat([header, payload]));
}

let upgraded = false;
let buf = Buffer.alloc(0);
let steerAttempts = 0;

process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  if (!upgraded) {
    const idx = buf.indexOf('\\r\\n\\r\\n');
    if (idx === -1) return;
    const req = buf.subarray(0, idx).toString('latin1');
    buf = buf.subarray(idx + 4);
    const key = /Sec-WebSocket-Key:\\s*([^\\r\\n]+)/i.exec(req)[1].trim();
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    process.stdout.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
    upgraded = true;
  }
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    const masked = Boolean(buf[1] & 0x80);
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    if (masked) off += 4;
    if (buf.length < off + len) return;
    let payload = buf.subarray(off, off + len);
    if (masked) {
      const mask = buf.subarray(off - 4, off);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    buf = buf.subarray(off + len);
    if (opcode === 0x8) { process.exit(0); }
    if (opcode !== 0x1) continue;
    const msg = JSON.parse(payload.toString('utf8'));
    if (msg.id === undefined) continue;
    const reply = (result) => sendWsText(JSON.stringify({ id: msg.id, result }));
    const replyErr = (code, message) => sendWsText(JSON.stringify({ id: msg.id, error: { code, message } }));

    if (msg.method === 'initialize') {
      reply({ userAgent: 'fake-codex' });
    } else if (msg.method === 'thread/list') {
      reply({
        data: [
          { id: '0195c1b2-aaaa-bbbb-cccc-000000000001', name: 'Idle Thread', cwd: '/tmp', status: { type: 'idle' } },
          { id: '0195c1b2-aaaa-bbbb-cccc-000000000002', name: 'Active Thread', cwd: '/tmp', status: { type: 'active' } },
          { id: '0195c1b2-aaaa-bbbb-cccc-000000000003', name: 'Unloaded Thread', cwd: '/tmp', status: { type: 'notLoaded' } },
        ],
      });
    } else if (msg.method === 'thread/read') {
      const id = msg.params.threadId;
      if (id.endsWith('0001')) reply({ thread: { id, status: { type: 'idle' } } });
      else if (id.endsWith('0002')) {
        const statusType = mode === 'stale-steer' && steerAttempts > 0 ? 'idle' : 'active';
        reply({ thread: { id, status: { type: statusType } } });
      } else if (id.endsWith('0003')) reply({ thread: { id, status: { type: 'notLoaded' } } });
      else replyErr(-32600, 'thread not found: ' + id);
    } else if (msg.method === 'thread/turns/list') {
      reply({ data: [{ id: 'turn-running-1', status: 'inProgress' }] });
    } else if (msg.method === 'turn/start') {
      if (mode === 'drop-on-write') process.exit(1);
      reply({ turn: { id: 'turn-started-1' } });
    } else if (msg.method === 'turn/steer') {
      steerAttempts++;
      if (mode === 'stale-steer') {
        replyErr(-32600, 'no active turn to steer');
      } else {
        reply({ turnId: msg.params.expectedTurnId });
      }
    }
  }
});
`;
  fs.writeFileSync(script, code, 'utf8');
  return script;
}

function writeFakeQueueScript(dir) {
  const script = path.join(dir, 'fake-codex-queue.mjs');
  fs.writeFileSync(
    script,
    `const args = process.argv.slice(2);
const threadIdx = args.indexOf('--thread');
const id = args[threadIdx + 1];
if (id.endsWith('9999')) {
  process.stderr.write('no rollout found for thread id\\n');
  process.exit(1);
}
process.stdout.write('Queued message q-42 for thread ' + id + '.\\n');
`,
    'utf8',
  );
  return script;
}

test('codex-daemon lists threads, starts idle turns, steers active turns, handles stale steer, and marks write-drop uncertain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-daemon-test-'));
  const proxyScript = writeFakeCodexProxy(dir);
  const queueScript = writeFakeQueueScript(dir);

  try {
    // Normal mode: list, idle turn/start, active turn/steer, wait_if_busy refusal, notLoaded error
    const conn = await openDaemon({ command: process.execPath, args: [proxyScript] });
    try {
      const threads = await listDaemonThreads(conn, { limit: 10 });
      assert.equal(threads.length, 3);
      assert.equal(threads[0].status, 'idle');

      const rIdle = await sendToDaemonThread(conn, {
        threadId: '0195c1b2-aaaa-bbbb-cccc-000000000001',
        text: 'hello idle',
        messageId: 'm-1',
      });
      assert.equal(rIdle.method, 'turn/start');

      const rActive = await sendToDaemonThread(conn, {
        threadId: '0195c1b2-aaaa-bbbb-cccc-000000000002',
        text: 'hello active',
        messageId: 'm-2',
      });
      assert.equal(rActive.method, 'turn/steer');

      await assert.rejects(
        () =>
          sendToDaemonThread(conn, {
            threadId: '0195c1b2-aaaa-bbbb-cccc-000000000002',
            text: 'wait please',
            messageId: 'm-3',
            allowSteer: false,
          }),
        err => err.reason === 'target_busy',
      );

      await assert.rejects(
        () =>
          sendToDaemonThread(conn, {
            threadId: '0195c1b2-aaaa-bbbb-cccc-000000000003',
            text: 'unloaded',
            messageId: 'm-4',
          }),
        err => err instanceof ThreadNotLoadedError,
      );
    } finally {
      conn.close();
    }

    // Stale-steer recovery: steer fails cleanly -> re-read shows idle -> starts new turn
    const connStale = await openDaemon({
      command: process.execPath,
      args: [proxyScript],
      env: { FAKE_PROXY_MODE: 'stale-steer' },
    });
    try {
      const recovered = await sendToDaemonThread(connStale, {
        threadId: '0195c1b2-aaaa-bbbb-cccc-000000000002',
        text: 'recovered',
        messageId: 'm-5',
      });
      assert.equal(recovered.method, 'turn/start');
    } finally {
      connStale.close();
    }

    // Drop after write must be marked deliveryUnknown (uncertain)
    const connDrop = await openDaemon({
      command: process.execPath,
      args: [proxyScript],
      env: { FAKE_PROXY_MODE: 'drop-on-write' },
    });
    try {
      await assert.rejects(
        () =>
          sendToDaemonThread(connDrop, {
            threadId: '0195c1b2-aaaa-bbbb-cccc-000000000001',
            text: 'maybe arrived',
            messageId: 'm-6',
          }),
        err => err.deliveryUnknown === true && err.reason === 'delivery_unconfirmed',
      );
    } finally {
      connDrop.close();
    }

    // Queue fallback
    const queued = await queueToCodexThread({
      threadId: '0195c1b2-aaaa-bbbb-cccc-000000000003',
      text: 'queued hello',
      command: process.execPath,
      args: [queueScript],
    });
    assert.deepEqual(queued, { method: 'queue', queueId: 'q-42' });

    await assert.rejects(
      () =>
        queueToCodexThread({
          threadId: '0195c1b2-aaaa-bbbb-cccc-000000009999',
          text: 'missing',
          command: process.execPath,
          args: [queueScript],
        }),
      err => err.reason === 'target_unavailable',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
