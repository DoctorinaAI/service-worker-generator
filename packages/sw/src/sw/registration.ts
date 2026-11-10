declare const self: ServiceWorkerGlobalScope;

/** Which of the registration's workers to read. */
export type WorkerSlot = 'installing' | 'waiting' | 'active';

/**
 * Version of the worker in [slot], read from the `?v=` that bootstrap
 * registers it with.
 *
 * - `undefined`: the slot is empty (or there is no registration).
 * - `null`: there is a worker, but its version cannot be read (unparsable
 *   URL, no `v` parameter).
 */
export function workerVersion(slot: WorkerSlot): string | null | undefined {
  let worker: { scriptURL?: string } | null | undefined;
  try {
    worker = (self as { registration?: ServiceWorkerRegistration }).registration?.[
      slot
    ];
  } catch {
    return undefined;
  }
  if (!worker) return undefined;
  try {
    return new URL(String(worker.scriptURL)).searchParams.get('v') || null;
  } catch {
    return null;
  }
}

/**
 * Whether another worker is installing or waiting in this registration —
 * a newer build of the app is already on the origin.
 *
 * The browser only creates a worker for a `sw.js` whose bytes differ from
 * the one it has, and every build injects its own manifest into that
 * script, so a worker in either slot means the files this worker has
 * cached are no longer the files the origin serves. Read on every fetch
 * rather than remembered: a worker is terminated between events, and the
 * registration is the one piece of state that survives that.
 *
 * `true` as well when the slot holds a worker whose version cannot be
 * read: the cache is then bypassed, which costs a download and never
 * correctness.
 */
export function hasPendingWorker(): boolean {
  return (
    workerVersion('installing') !== undefined ||
    workerVersion('waiting') !== undefined
  );
}

/**
 * Versions of the workers in [slots], or `null` when one of them is there
 * but its version cannot be read. Callers that delete temp caches must
 * then keep them all: one of them belongs to that worker.
 */
export function allVersionsOrNull(slots: readonly WorkerSlot[]): string[] | null {
  const versions: string[] = [];
  for (const slot of slots) {
    const v = workerVersion(slot);
    if (v === null) return null;
    if (v) versions.push(v);
  }
  return versions;
}

/**
 * Versions of the workers in [slots] that could be read. A worker without
 * a readable version names no version to keep.
 */
export function readableVersions(slots: readonly WorkerSlot[]): string[] {
  const versions: string[] = [];
  for (const slot of slots) {
    const v = workerVersion(slot);
    if (v) versions.push(v);
  }
  return versions;
}
