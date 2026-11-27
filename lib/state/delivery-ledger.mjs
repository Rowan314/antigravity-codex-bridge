// Per-sender delivery ledger providing idempotency, retry gating, and safe uncertainty handling.
import crypto from 'node:crypto';
import path from 'node:path';
import { failure, outcome } from '../core/outcome.mjs';
import { withStateLock } from './file-lock.mjs';
import { ensurePrivateDir, readBoundedJson, writePrivateJsonAtomic } from './state-dir.mjs';

const LEDGER_DIR = 'deliveries';
const MAX_ROWS_PER_OWNER = 500;

function ownerFilePath(stateDir, owner) {
  const key = `${owner.app}:${owner.id}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(stateDir, LEDGER_DIR, `${hash}.json`);
}

function sameDraft(existing, draft) {
  return (
    existing.from?.app === draft.from.app &&
    existing.from?.id === draft.from.id &&
    existing.to?.app === draft.to.app &&
    existing.to?.id === draft.to.id &&
    existing.message === draft.message
  );
}

function loadLedger(filePath) {
  const data = readBoundedJson(filePath, 4 * 1024 * 1024);
  if (!data || typeof data !== 'object' || !Array.isArray(data.records)) {
    return { records: [] };
  }
  return data;
}

function saveLedger(filePath, ledger) {
  ensurePrivateDir(path.dirname(filePath));
  if (ledger.records.length > MAX_ROWS_PER_OWNER) {
    ledger.records = ledger.records.slice(-MAX_ROWS_PER_OWNER);
  }
  writePrivateJsonAtomic(filePath, ledger);
}

/**
 * Reserve a delivery row before touching any transport.
 * Returns:
 *   { action: 'send', record }            -> caller may proceed to write to transport
 *   { action: 'replay', record, outcome } -> already submitted; return existing receipt without sending
 * Throws BridgeError with outcome attached for in_flight / prior_uncertain / id_conflict / failed-without-retry-flag.
 */
export async function reserveDelivery(stateDir, draft, { retryFailed = false, signal } = {}) {
  const filePath = ownerFilePath(stateDir, draft.from);
  return withStateLock(
    stateDir,
    () => {
      const ledger = loadLedger(filePath);
      const existing = ledger.records.find(r => r.message_id === draft.message_id);

      if (existing) {
        if (!sameDraft(existing, draft)) {
          throw failure(
            'This message_id is already used for a different recipient or message text. Use a new message_id.',
            'id_conflict',
            { record: existing, outcome: outcome('id_conflict', { record: existing }) },
          );
        }
        if (existing.status === 'submitted') {
          return {
            action: 'replay',
            record: existing,
            outcome: outcome('already_submitted', { record: existing }),
          };
        }
        if (existing.status === 'sending') {
          throw failure(
            'A send with this message_id is still in flight. Wait and inspect list_deliveries.',
            'in_flight',
            { record: existing, outcome: outcome('in_flight', { record: existing }) },
          );
        }
        if (existing.status === 'uncertain') {
          throw failure(
            'The previous attempt with this message_id had an unconfirmed result. Inspect the target conversation and list_deliveries before sending again.',
            'prior_uncertain',
            { record: existing, outcome: outcome('prior_uncertain', { record: existing }) },
          );
        }
        if (existing.status === 'failed') {
          if (!retryFailed) {
            throw failure(
              'A prior attempt with this message_id failed before writing. Pass retry_failed: true with the exact same ID, recipient, and text to retry.',
              existing.error_reason || 'route_unavailable',
              {
                record: existing,
                outcome: outcome(existing.error_reason || 'route_unavailable', { record: existing }),
              },
            );
          }
          existing.status = 'sending';
          existing.updated_at = Date.now();
          delete existing.error;
          delete existing.error_reason;
          saveLedger(filePath, ledger);
          return { action: 'send', record: { ...existing } };
        }
      }

      const now = Date.now();
      const record = {
        message_id: draft.message_id,
        from: draft.from,
        to: draft.to,
        message: draft.message,
        status: 'sending',
        created_at: now,
        updated_at: now,
      };
      ledger.records.push(record);
      saveLedger(filePath, ledger);
      return { action: 'send', record: { ...record } };
    },
    { signal },
  );
}

export async function settleDelivery(stateDir, owner, messageId, update) {
  const filePath = ownerFilePath(stateDir, owner);
  // Settlement intentionally ignores call cancellation so terminal outcomes are persisted.
  return withStateLock(stateDir, () => {
    const ledger = loadLedger(filePath);
    const row = ledger.records.find(r => r.message_id === messageId);
    if (!row) return null;
    row.status = update.status;
    row.updated_at = Date.now();
    if (update.transport) row.transport = update.transport;
    if (update.error) row.error = update.error;
    else delete row.error;
    if (update.error_reason) row.error_reason = update.error_reason;
    else delete row.error_reason;
    saveLedger(filePath, ledger);
    return { ...row };
  });
}

export function listDeliveries(stateDir, owner, { messageId, limit = 20 } = {}) {
  const filePath = ownerFilePath(stateDir, owner);
  const ledger = loadLedger(filePath);
  let rows = [...ledger.records].reverse();
  if (messageId) {
    rows = rows.filter(r => r.message_id === messageId);
  }
  return rows.slice(0, Math.max(1, Math.min(limit, 100)));
}
