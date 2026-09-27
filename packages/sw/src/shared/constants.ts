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

/**
 * How long a precached response body may produce no bytes before we give up
 * on it.
 *
 * `FETCH_TIMEOUT_MS` only covers the headers: once they arrive, the abort
 * timer is cleared and a multi-megabyte body (`main.dart.js` is routinely
 * ~10 MB) streams with no deadline at all. A body that stalls mid-stream
 * therefore hangs `cache.put`, which hangs `install`, which never finishes
 * — and an install that never finishes blocks the scope's job queue, so
 * every later `register()` and `unregister()` on the origin hangs too.
 *
 * Measured against idle time rather than total duration on purpose: a slow
 * connection that keeps delivering bytes must be allowed to finish, however
 * long it takes. Only a stream that has genuinely stopped is cut.
 */
export const BODY_STALL_TIMEOUT_MS = 30_000;

/** Default SW registration timeout in milliseconds */
export const SW_REGISTRATION_TIMEOUT_MS = 4_000;

/**
 * How long bootstrap waits for a pre-existing waiting worker to take control
 * after `skipWaiting`. A handover that works lands in a few milliseconds.
 * One that loses the race described at `activateWaitingAtBootstrap` does not
 * land while the page is open at all, so waiting longer only delays the same
 * outcome: booting with the current controller.
 */
export const SW_HANDOFF_TIMEOUT_MS = 500;

/**
 * Hard cap on the whole service-worker step of the bootstrap pipeline.
 *
 * The service worker is a caching accelerator, never a prerequisite for the
 * first frame, so the pipeline must not be able to wait on it forever. Every
 * call inside that step — `getRegistrations()`, `register()`, `unregister()`
 * — goes through the scope's job queue and inherits its liveness: one wedged
 * install elsewhere and none of them ever settle.
 *
 * Sized well above a healthy run: registration itself is a script fetch, and
 * activation already gives up after `SW_REGISTRATION_TIMEOUT_MS`.
 */
export const SW_BOOTSTRAP_TIMEOUT_MS = 10_000;

/**
 * Budget for the loading widget's reset action before it reloads anyway.
 *
 * The button exists to rescue a wedged page, and the wedge it rescues is
 * exactly the one that makes `unregister()` hang — so waiting on cleanup
 * without a deadline would strand the user on the screen they clicked it to
 * escape. Whatever cleanup lands within the budget is kept; the reload is
 * unconditional.
 */
export const RESET_TIMEOUT_MS = 3_000;

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

/**
 * Same-origin path prefixes whose navigations the SW must not answer.
 *
 * Hosts reserve namespaces that they serve themselves and exclude from the
 * SPA rewrite. Firebase Hosting owns `/__/*`, which is where Firebase Auth
 * puts `/__/auth/handler` and `/__/auth/iframe` when `authDomain` is the
 * app's own domain — both same-origin navigations (the iframe included).
 * Routing them through the app's navigation handler would run a sign-in
 * document through `fetchWithRetry`, which downgrades a navigation
 * request's mode and turns a 3xx into an opaque redirect, and would answer
 * it from the app shell whenever the origin hiccups.
 */
export const RESERVED_PATH_PREFIXES = ['__/'] as const;
