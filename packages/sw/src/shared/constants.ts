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

/**
 * How long the CanvasKit CDN probe waits, once, before the engine is
 * loaded from the copy the build ships.
 *
 * The probe is one byte of the variant's `.js` with `cache: 'no-store'`,
 * and it blocks the engine download behind it. Two attempts of an 8 s
 * timeout plus backoff — what this used to be — is up to ~17 s of
 * "Loading rendering engine" on a network where `gstatic.com` is blocked,
 * on the first load of every tab session. A CDN that cannot answer one
 * byte within this is not the faster source it was chosen for, and the
 * local directory is same-origin and cached after the first load.
 */
export const CANVASKIT_PROBE_TIMEOUT_MS = 3_000;

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

/**
 * How long a navigation waits for the origin before the pre-cached shell
 * answers it.
 *
 * A navigation is the one request a user is watching a blank page for, and
 * the cached shell boots the app, which then loads its own route. Three
 * retries of `FETCH_TIMEOUT_MS` plus their backoff — the budget every other
 * request gets — would hold that blank page for over half a minute before
 * falling back to a copy that was ready all along.
 *
 * The fetch is not aborted when the deadline passes: aborting needs a
 * `signal`, an init makes `fetch` build a new `Request`, and a navigation
 * request rebuilt that way loses its `navigate` mode — the origin stops
 * seeing `Sec-Fetch-Mode: navigate`, and a same-origin 3xx stops arriving
 * as the opaque redirect the browser must follow. So the answer comes from
 * the cache and the response is left to finish into the shell cache.
 */
export const NAVIGATION_TIMEOUT_MS = 3_000;

/** Default SW registration timeout in milliseconds */
export const SW_REGISTRATION_TIMEOUT_MS = 4_000;

/**
 * How long bootstrap waits for the current controller to answer
 * `getVersion` with its engine revision. A live worker answers in
 * milliseconds; a worker from a release that predates the field answers
 * without it, which counts as unknown, exactly like no answer.
 */
export const SW_ENGINE_QUERY_TIMEOUT_MS = 500;

/**
 * How long the first load after a deploy that changed the Flutter engine
 * waits for the new worker to finish installing. The old worker would
 * serve the previous build's Dart code next to this build's engine, so
 * the wait is the price of a load that works. The install bounds itself
 * (fetch retries, the body stall watchdog) and ends `redundant` on
 * failure; this is the outer limit for a slow but live precache.
 */
export const SW_UPDATE_INSTALL_TIMEOUT_MS = 60_000;

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

/**
 * Stall threshold while nothing is reporting progress to the page.
 *
 * Progress between 25% and 80% comes from the worker's `sw-progress`
 * messages. A page that has no controller hears none of them: a first
 * visit (activation is capped at `SW_REGISTRATION_TIMEOUT_MS`, so the page
 * usually boots uncontrolled), Firefox's private mode, iOS Lockdown Mode,
 * or any registration that failed. The ring then sits still for the whole
 * `main.dart.wasm` download — and on a slow link `STALLED_TIMEOUT_MS` of
 * that is normal, not a stall, while the overlay's reset would throw away
 * the download in progress and start it again.
 *
 * So the threshold is raised for exactly that case, and only until the
 * first message arrives. The overlay still appears for a load that is
 * genuinely wedged; it just waits as long as a 3G download of a wasm app
 * plausibly takes.
 */
export const UNREPORTED_STALLED_TIMEOUT_MS = 120_000;

/** Max retry attempts for failed fetches */
export const MAX_RETRY_ATTEMPTS = 3;

/** Base delay for exponential backoff in milliseconds */
export const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Upper bound on a server's `Retry-After` that a precache retry will wait.
 * Install is on the clock (and blocks the scope's job queue while it runs),
 * so a host asking for minutes gets a few seconds; the attempt budget is
 * unchanged.
 */
export const RETRY_AFTER_MAX_MS = 5_000;

/**
 * How many entries the temp → content swap moves at once.
 *
 * Each move is a `put` followed by a `delete`, so at most this many
 * entries exist in both caches at the same time. Moving them all at once
 * (a plain `Promise.all`) means the whole pre-cached set does — every byte
 * of a wasm app twice — which is how activate hits `QuotaExceededError` on
 * Safari's quota. Low enough to bound that, high enough that the swap is
 * not a serial walk over hundreds of entries.
 */
export const SWAP_CONCURRENCY = 4;

/**
 * Smallest gap between two byte-level `sw-progress` messages for one
 * resource.
 *
 * The pre-cached set is dominated by one or two multi-megabyte files, and
 * without byte counts the ring does not move for the length of their
 * download. Each message is a `clients.matchAll` round trip and a
 * broadcast to every open tab, so they are throttled per resource: four a
 * second is a smooth ring and a cost that does not scale with chunk size.
 */
export const PROGRESS_THROTTLE_MS = 250;

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
 * Routing them through the app's navigation handler would answer a sign-in
 * document from the app shell whenever the origin hiccups, and would give
 * it the shell's deadline. Their navigations are answered with the
 * navigation preload response or the request on the network, untouched.
 */
export const RESERVED_PATH_PREFIXES = ['__/'] as const;
