import type {
  ResourceManifest,
  SWProgressMessage,
  SWProgressStatus,
} from '../shared/types';
import { ResourceCategory } from '../shared/types';
import { notifyClients } from './notify';

declare const self: ServiceWorkerGlobalScope;

/**
 * Categories that make up the *counted set* — the resources every client
 * is guaranteed to hear about during startup, because the SW pre-caches
 * them on install.
 *
 * Everything else is cached lazily on first fetch. Whether such a resource
 * is requested at all during a given startup depends on the browser, the
 * route and the CanvasKit CDN, so it cannot belong to a denominator that
 * is fixed at build time. The same list drives `precacheResources`, which
 * keeps "what is pre-cached" and "what is counted" identical by
 * construction.
 */
export const COUNTED_CATEGORIES: readonly ResourceCategory[] = [
  ResourceCategory.Core,
  ResourceCategory.Required,
];

/** A single resource-level progress event. */
export interface ProgressUpdate {
  /** Manifest key, e.g. `main.dart.wasm`. Empty for lifecycle-only beats. */
  key: string;
  /** File basename for display. */
  name: string;
  /** Full request URL. */
  url: string;
  /** Size of this resource in bytes. */
  size: number;
  /** Bytes loaded so far. */
  loaded: number;
  /** Terminal or in-flight status. */
  status: SWProgressStatus;
  /** Failure reason when [status] is `error`. */
  error?: string;
}

/**
 * Broadcasts `sw-progress` messages with one self-consistent view of how
 * much there is to load.
 *
 * The numerator a client accumulates from these messages and the
 * `resourcesCount` denominator it renders them against must describe the
 * *same* set of resources. Deriving them from different sets is what
 * produced `Loaded 5 of 4 resources`: the total counted only pre-cached
 * files while the client counted every resource the fetch handler served.
 * `counted` therefore travels per message, so a client never has to
 * re-derive set membership from the manifest.
 */
export interface ProgressReporter {
  /** Total bytes of the counted set. */
  readonly resourcesSize: number;
  /** Size of the counted set — the denominator clients render against. */
  readonly resourcesCount: number;
  /** Whether [key] belongs to the counted set. */
  isCounted(key: string): boolean;
  /** Broadcast one progress message to every client. */
  report(update: ProgressUpdate): Promise<void>;
}

/**
 * Create a [ProgressReporter] over [manifest], stamping every message with
 * [version] so clients can tell which worker spoke. A page can be talked
 * to by two workers at once — an old controller still serving fetches
 * while a new build pre-caches in the background — and their manifests,
 * hence their denominators, need not agree.
 */
export function createProgressReporter(
  version: string,
  manifest: ResourceManifest,
): ProgressReporter {
  const counted = new Set<string>();
  let resourcesSize = 0;
  for (const [key, entry] of Object.entries(manifest)) {
    if (!COUNTED_CATEGORIES.includes(entry.category)) continue;
    counted.add(key);
    resourcesSize += entry.size;
  }
  const resourcesCount = counted.size;

  return {
    resourcesSize,
    resourcesCount,
    isCounted: (key: string): boolean => counted.has(key),
    report: async (update: ProgressUpdate): Promise<void> => {
      const message: SWProgressMessage = {
        type: 'sw-progress',
        timestamp: Date.now(),
        swVersion: version,
        resourcesSize,
        resourcesCount,
        resourceName: update.name,
        resourceUrl: update.url,
        resourceKey: update.key,
        resourceSize: update.size,
        loaded: update.loaded,
        status: update.status,
        counted: counted.has(update.key),
      };
      if (update.error !== undefined) message.error = update.error;
      await notifyClients(self, message);
    },
  };
}
