import { formatBytes } from '../shared/utils';
import { log } from '../shared/logger';

/**
 * Minimum gap between two storage estimates in the log. A precache that
 * runs out of quota fails every remaining entry, and one estimate per
 * entry would bury the line that matters.
 */
const ESTIMATE_LOG_INTERVAL_MS = 10_000;

let lastEstimateAt = -Infinity;

/** Whether [error] is the Cache API's out-of-storage error. */
export function isQuotaExceeded(error: unknown): boolean {
  try {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'QuotaExceededError'
    );
  } catch {
    return false;
  }
}

/**
 * Whether [error] is a quota error, or was caused by one.
 *
 * An aggregate — the one a failed precache throws, which names every Core
 * entry that failed — carries the first quota error as its `cause`.
 * Without walking it, the one phase where running out of storage is most
 * likely reported itself as an ordinary failure.
 */
export function causedByQuota(error: unknown): boolean {
  let current = error;
  // A `cause` chain is written by hand here, so three links is generous;
  // the bound also makes a cycle impossible to loop on.
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth++) {
    if (isQuotaExceeded(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * If [error] is a `QuotaExceededError`, log it as such — naming [context],
 * e.g. `precaching main.dart.wasm` — and, when the browser exposes it, the
 * origin's storage usage and quota.
 *
 * Diagnostics only: the estimate is fire-and-forget, so the caller is
 * never delayed by it, and nothing here can throw. Returns whether the
 * error was a quota error, so callers can skip their generic log.
 */
export function reportIfQuotaExceeded(context: string, error: unknown): boolean {
  if (!isQuotaExceeded(error)) return false;
  try {
    log.error(`[SW] Storage quota exceeded while ${context}:`, error);
    const now = Date.now();
    if (now - lastEstimateAt < ESTIMATE_LOG_INTERVAL_MS) return true;
    lastEstimateAt = now;
    const storage = (
      globalThis as {
        navigator?: { storage?: { estimate?: () => Promise<StorageEstimate> } };
      }
    ).navigator?.storage;
    const pending = storage?.estimate?.();
    if (pending && typeof pending.then === 'function') {
      pending.then(
        (estimate) => {
          const usage = estimate?.usage;
          const quota = estimate?.quota;
          log.warn(
            `[SW] Storage estimate: usage ${fmt(usage)} of quota ${fmt(quota)}`,
          );
        },
        () => undefined,
      );
    }
  } catch {
    // Logging must never become the failure.
  }
  return true;
}

function fmt(bytes: number | undefined): string {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0
    ? `${formatBytes(bytes)} (${bytes} B)`
    : 'unknown';
}

/** Test-only: forget the last estimate time. */
export function resetQuotaReportThrottle(): void {
  lastEstimateAt = -Infinity;
}
