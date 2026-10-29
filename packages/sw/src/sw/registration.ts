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
