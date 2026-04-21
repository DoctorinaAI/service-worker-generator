/** Default cache name prefix */
export const DEFAULT_CACHE_PREFIX = 'app-cache';

/** Suffix for temporary cache during install */
export const TEMP_CACHE_SUFFIX = '-temp';

/** Cache name for manifest storage (unversioned) */
export const MANIFEST_CACHE_SUFFIX = '-manifest';

/** Google CDN base URL for CanvasKit */
export const CANVASKIT_CDN_BASE = 'https://www.gstatic.com/flutter-canvaskit';

/** Local fallback path for CanvasKit */
export const CANVASKIT_LOCAL_PATH = 'canvaskit';

/** Default fetch timeout in milliseconds */
export const FETCH_TIMEOUT_MS = 10_000;

/** Default SW registration timeout in milliseconds */
export const SW_REGISTRATION_TIMEOUT_MS = 4_000;

/** Stalled loading detection timeout in milliseconds */
export const STALLED_TIMEOUT_MS = 30_000;

/** Max retry attempts for failed fetches */
export const MAX_RETRY_ATTEMPTS = 3;

/** Base delay for exponential backoff in milliseconds */
export const RETRY_BASE_DELAY_MS = 1_000;

/** Max parallel fetches during SW install precache. Keeps us under HTTP/2
 * multiplexing limits and spares memory on large manifests. */
export const PRECACHE_CONCURRENCY = 6;

/** Default progress range */
export const DEFAULT_MIN_PROGRESS = 0;
export const DEFAULT_MAX_PROGRESS = 90;

/** Progress milestones for each pipeline stage */
export const STAGE_PROGRESS = {
  start: 0,
  init: 1,
  sw: 2,
  canvaskit: 20,
  assets: 80,
  dartEntryLoaded: 85,
  dartEntry: 90,
  dartInit: 100,
} as const;

// The literal placeholder tokens `"__INJECT_SW_CONFIG__"` and
// `"__INJECT_BOOTSTRAP_CONFIG__"` live inline in sw/index.ts and
// bootstrap/index.ts respectively. They are intentionally NOT exported
// from this module — keeping them out of the public surface avoids
// accidentally bundling them into downstream code that could log or
// expose the internal build contract.

/**
 * Files the SW should NOT intercept — browser loads them directly.
 * `bootstrap.js` runs before the SW is active and `sw.js` is the worker
 * script itself; intercepting either would break bootstrap/update flows.
 * `index.html` is explicitly absent: it goes through the networkFirst
 * branch of fetch-handler so navigations get fresh HTML with cache fallback.
 */
export const NEVER_CACHE_FILES = ['bootstrap.js', 'sw.js'] as const;
