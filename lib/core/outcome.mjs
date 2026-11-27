// Closed vocabulary of delivery/diagnostic outcome reasons.
// Intentionally excludes any version-comparison reason: routing relies on capability probing.

export const REASONS = Object.freeze({
  submitted: { delivered: true, retry: 'no' },
  already_submitted: { delivered: true, retry: 'no' },
  settlement_failed: { delivered: true, retry: 'inspect' },
  in_flight: { delivered: 'unknown', retry: 'inspect' },
  prior_uncertain: { delivered: 'unknown', retry: 'inspect' },
  delivery_unconfirmed: { delivered: 'unknown', retry: 'inspect' },
  id_conflict: { delivered: false, retry: 'new_id' },
  invalid_argument: { delivered: false, retry: 'new_id' },
  message_too_long: { delivered: false, retry: 'new_id' },
  wrong_tool: { delivered: false, retry: 'no' },
  caller_unverified: { delivered: false, retry: 'after_fix' },
  caller_ambiguous: { delivered: false, retry: 'same_id' },
  target_unavailable: { delivered: false, retry: 'after_fix' },
  target_busy: { delivered: false, retry: 'same_id' },
  route_unavailable: { delivered: false, retry: 'after_fix' },
  access_denied: { delivered: false, retry: 'after_fix' },
  protocol_incompatible: { delivered: false, retry: 'after_fix' },
  request_rejected: { delivered: false, retry: 'new_id' },
  deadline: { delivered: false, retry: 'same_id' },
  cancelled: { delivered: false, retry: 'same_id' },
  state_busy: { delivered: false, retry: 'same_id' },
  server_busy: { delivered: false, retry: 'same_id' },
  state_unavailable: { delivered: false, retry: 'after_fix' },
  setup_incomplete: { delivered: false, retry: 'after_fix' },
  internal_error: { delivered: false, retry: 'inspect' },
});

export const OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    delivered: { oneOf: [{ type: 'boolean' }, { type: 'string', const: 'unknown' }] },
    retry: { type: 'string', enum: ['same_id', 'after_fix', 'new_id', 'inspect', 'no'] },
    reason: { type: 'string', enum: Object.keys(REASONS) },
    record: { type: 'object' },
  },
  required: ['delivered', 'retry', 'reason'],
  additionalProperties: false,
};

export class BridgeError extends Error {
  constructor(message, reason = 'internal_error', extra = {}) {
    super(message);
    this.name = 'BridgeError';
    this.reason = Object.hasOwn(REASONS, reason) ? reason : 'internal_error';
    Object.assign(this, extra);
  }
}

export function failure(message, reason = 'internal_error', extra = {}) {
  return new BridgeError(message, reason, extra);
}

export function tagged(error, reason) {
  const err = error instanceof Error ? error : new Error(String(error));
  err.reason = Object.hasOwn(REASONS, reason) ? reason : 'internal_error';
  return err;
}

export function markDeliveryUnknown(error) {
  const err = error instanceof Error ? error : new Error(String(error));
  err.deliveryUnknown = true;
  err.reason = 'delivery_unconfirmed';
  if (!/may already have arrived/i.test(err.message)) {
    err.message = `${err.message} The message may already have arrived.`;
  }
  return err;
}

export function unconfirmedReply(source, detail, baseError) {
  const err = baseError instanceof Error ? baseError : new Error();
  err.message = `${source} could not confirm delivery${detail ? ` (${detail})` : ''}.`;
  return markDeliveryUnknown(err);
}

export function outcome(reason, { record } = {}) {
  const spec = REASONS[reason] ?? REASONS.internal_error;
  const result = {
    delivered: spec.delivered,
    retry: spec.retry,
    reason: Object.hasOwn(REASONS, reason) ? reason : 'internal_error',
  };
  if (record !== undefined) result.record = record;
  return result;
}

export function errorOutcome(error, fallbackReason = 'internal_error') {
  if (error?.outcome) return error.outcome;
  if (error?.deliveryUnknown) return outcome('delivery_unconfirmed', { record: error.record });
  const reason = Object.hasOwn(REASONS, error?.reason) ? error.reason : fallbackReason;
  return outcome(reason, { record: error?.record });
}

export function publicDelivery(record, { includeMessage = true } = {}) {
  const out = {
    message_id: record.message_id,
    from: record.from,
    to: record.to,
    created_at: record.created_at,
    status: record.status,
  };
  if (includeMessage && record.message !== undefined) out.message = record.message;
  if (record.updated_at !== undefined) out.updated_at = record.updated_at;
  if (record.transport !== undefined) out.transport = record.transport;
  if (record.error !== undefined) out.error = record.error;
  return out;
}
