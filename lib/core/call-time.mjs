import { performance } from 'node:perf_hooks';
import { failure } from './outcome.mjs';

export const CALL_DEADLINE_MS = 55_000;
export const WRITE_RESERVE_MS = 3_000;

export function monotonicNow() {
  return performance.now();
}

export function cancelledError(message = 'The bridge call was cancelled before sending.') {
  return failure(message, 'cancelled');
}

export function deadlineError(message = 'The bridge call ran out of time before sending.') {
  return failure(message, 'deadline');
}

export function isStoppedSignal(signal) {
  return Boolean(signal?.aborted);
}

export function stopError(signal) {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  if (reason instanceof Error && reason.reason) return reason;
  if (reason?.code === 'DEADLINE' || reason === 'deadline') return deadlineError();
  return cancelledError();
}

export function throwIfStopped(signal) {
  const err = stopError(signal);
  if (err) throw err;
}

/**
 * Create a bounded call context backed by an AbortController.
 * External cancellation and the wall-clock deadline flow through the same signal.
 */
export function startCall({ budgetMs = CALL_DEADLINE_MS, signal: parentSignal } = {}) {
  const controller = new AbortController();
  const startedAt = monotonicNow();
  const deadlineAt = startedAt + budgetMs;

  const onParentAbort = () => {
    controller.abort(stopError(parentSignal) ?? cancelledError());
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(deadlineError());
    }
  }, budgetMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    deadlineAt,
    remainingMs() {
      return Math.max(0, Math.floor(deadlineAt - monotonicNow()));
    },
    cancel(err = cancelledError()) {
      if (!controller.signal.aborted) controller.abort(err);
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * Guard immediately before crossing a mutating transport boundary.
 */
export function beforeWrite(signal, minRemainingMs = 250, deadlineAt) {
  throwIfStopped(signal);
  if (deadlineAt !== undefined && deadlineAt - monotonicNow() < minRemainingMs) {
    throw deadlineError('Not enough call budget remained to safely start the transport write.');
  }
}

export function attemptSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const onParent = () => controller.abort(stopError(parentSignal) ?? cancelledError());
  if (parentSignal) {
    if (parentSignal.aborted) onParent();
    else parentSignal.addEventListener('abort', onParent, { once: true });
  }
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(deadlineError('The local transport attempt timed out.'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParent);
    },
  };
}
