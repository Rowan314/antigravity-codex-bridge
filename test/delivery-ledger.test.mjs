import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listDeliveries, reserveDelivery, settleDelivery } from '../lib/state/delivery-ledger.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-ledger-'));
}

test('delivery ledger supports idempotent replay, conflict rejection, failed retry, and uncertain guard', async () => {
  const stateDir = makeTempDir();
  try {
    const baseDraft = {
      message_id: 'req-1',
      from: { app: 'antigravity', id: 'conv-a' },
      to: { app: 'codex', id: '0195c1b2-aaaa-bbbb-cccc-1234567890ab' },
      message: 'Ping from Antigravity',
    };

    // 1. Reserve & settle submitted
    const first = await reserveDelivery(stateDir, baseDraft);
    assert.equal(first.action, 'send');
    assert.equal(first.record.status, 'sending');

    await settleDelivery(stateDir, baseDraft.from, 'req-1', { status: 'submitted', transport: 'daemon' });

    // 2. Same ID + same payload -> replay without resending
    const replay = await reserveDelivery(stateDir, baseDraft);
    assert.equal(replay.action, 'replay');
    assert.equal(replay.outcome.reason, 'already_submitted');
    assert.equal(replay.outcome.delivered, true);

    // 3. Same ID + different text -> id_conflict
    await assert.rejects(
      () => reserveDelivery(stateDir, { ...baseDraft, message: 'Different body' }),
      err => err.reason === 'id_conflict' && err.outcome.retry === 'new_id',
    );

    // 4. Failed attempt requires retry_failed: true
    const draft2 = { ...baseDraft, message_id: 'req-2' };
    await reserveDelivery(stateDir, draft2);
    await settleDelivery(stateDir, draft2.from, 'req-2', {
      status: 'failed',
      error: 'daemon offline',
      error_reason: 'route_unavailable',
    });

    await assert.rejects(() => reserveDelivery(stateDir, draft2), err => err.reason === 'route_unavailable');
    const retried = await reserveDelivery(stateDir, draft2, { retryFailed: true });
    assert.equal(retried.action, 'send');
    await settleDelivery(stateDir, draft2.from, 'req-2', { status: 'submitted', transport: 'queue' });

    // 5. Uncertain attempt can never be retried automatically
    const draft3 = { ...baseDraft, message_id: 'req-3' };
    await reserveDelivery(stateDir, draft3);
    await settleDelivery(stateDir, draft3.from, 'req-3', {
      status: 'uncertain',
      error: 'socket dropped after write',
      error_reason: 'delivery_unconfirmed',
    });
    await assert.rejects(
      () => reserveDelivery(stateDir, draft3, { retryFailed: true }),
      err => err.reason === 'prior_uncertain' && err.outcome.retry === 'inspect',
    );

    // 6. Listing returns newest first and supports exact message_id lookup
    const all = listDeliveries(stateDir, baseDraft.from, { limit: 10 });
    assert.deepEqual(
      all.map(r => r.message_id),
      ['req-3', 'req-2', 'req-1'],
    );
    const single = listDeliveries(stateDir, baseDraft.from, { messageId: 'req-2' });
    assert.equal(single.length, 1);
    assert.equal(single[0].transport, 'queue');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
