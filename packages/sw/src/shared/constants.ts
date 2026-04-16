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

/** Default progress range */
export const DEFAULT_MIN_PROGRESS = 0;
export const DEFAULT_MAX_PROGRESS = 90;

/** Progress milestones for each pipeline stage */
export const STAGE_PROGRESS = {
  init: 1,
  sw: 2,
  canvaskit: 20,
  assets: 80,
  dartEntry: 90,
  dartInit: 100,
} as const;

/** Placeholder tokens replaced by Dart CLI at generation time */
export const SW_CONFIG_PLACEHOLDER = '"__INJECT_SW_CONFIG__"';
export const BOOTSTRAP_CONFIG_PLACEHOLDER = '"__INJECT_BOOTSTRAP_CONFIG__"';

/** Files that should never be cached by the SW */
export const NEVER_CACHE_FILES = [
  'bootstrap.js',
  'index.html',
  'sw.js',
] as const;
