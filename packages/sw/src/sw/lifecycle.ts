import type {
  SWLifecycleMessage,
  SWLifecyclePhase,
  SWStatusMessage,
} from '../shared/types';
import { log } from '../shared/logger';
import { causedByQuota } from './quota';
import { notifyClients } from './notify';
import { ownCacheNames } from '../shared/cache-ownership';

declare const self: ServiceWorkerGlobalScope;

/**
 * The last failure this worker had, for a client that asks later.
 *
 * A page that loads after the install failed has no message to catch — the
 * broadcast happened before it existed — so the one thing that went wrong
 * is kept here and handed to `getStatus`.
 */
let lastError: SWStatusMessage['lastError'];

/**
 * Tell every client what just happened to this worker.
 *
 * Never rejects and never throws: the callers are error paths, and a
 * failure to report a failure must not replace it.
 */
export async function reportLifecycle(
  version: string,
  phase: SWLifecyclePhase,
  status: SWLifecycleMessage['status'],
  error?: unknown,
): Promise<void> {
  const reason =
    error === undefined
      ? undefined
      : error instanceof Error
        ? error.message
        : String(error);
  const isQuota = error !== undefined && causedByQuota(error);
  if (status === 'failed' && reason !== undefined) {
    lastError = { phase, reason, isQuota };
  }
  const message: SWLifecycleMessage = {
    type: 'sw-lifecycle',
    timestamp: Date.now(),
    swVersion: version,
    phase,
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(isQuota ? { isQuota } : {}),
  };
  try {
    await notifyClients(self, message);
  } catch (reportError) {
    log.warn('[SW] Lifecycle report failed:', reportError);
  }
}

/**
 * Everything a client can usefully know about this worker's storage: the
 * app's caches with their entry counts, the browser's estimate, and the
 * last failure.
 *
 * Best-effort throughout — a blocked CacheStorage or a browser without
 * `storage.estimate` leaves that part out rather than failing the reply.
 */
export async function collectStatus(
  version: string,
  cachePrefix: string,
  engineRevision?: string,
): Promise<Omit<SWStatusMessage, 'type' | 'requestId'>> {
  const caches: Record<string, number> = {};
  try {
    const names = ownCacheNames(cachePrefix, await globalThis.caches.keys());
    for (const name of names) {
      try {
        const cache = await globalThis.caches.open(name);
        caches[name] = (await cache.keys()).length;
      } catch {
        // A cache that cannot be opened is reported as unknown rather than
        // dropping the whole reply.
        caches[name] = -1;
      }
    }
  } catch (error) {
    log.warn('[SW] Could not list caches for getStatus:', error);
  }

  let storage: SWStatusMessage['storage'];
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate) {
      storage = {
        ...(typeof estimate.usage === 'number' ? { usage: estimate.usage } : {}),
        ...(typeof estimate.quota === 'number' ? { quota: estimate.quota } : {}),
      };
    }
  } catch {
    // Not available, or refused: left out.
  }

  return {
    swVersion: version,
    ...(engineRevision ? { engineRevision } : {}),
    caches,
    ...(storage ? { storage } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

/** Test-only: forget the remembered failure. */
export function resetLastError(): void {
  lastError = undefined;
}
