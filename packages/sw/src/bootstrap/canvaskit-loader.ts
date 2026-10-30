import type { FlutterBuildEntry } from '../shared/types';
import { CANVASKIT_CDN_BASE, CANVASKIT_LOCAL_PATH } from '../shared/constants';
import { fetchWithRetry, fetchWithTimeout } from '../shared/utils';
import { logPhase } from './console-logger';

/**
 * sessionStorage key that pins this tab session to the local engine.
 *
 * Set when the CDN probe fails, or when the app failed to load because of
 * the engine served from the CDN (see `isCdnEngineFailure`). While it is set, `loadCanvasKit` skips the
 * probe and uses the local `canvaskit/` directory. Per tab session by
 * design: a CDN that is blocked now may be reachable tomorrow.
 */
export const CANVASKIT_LOCAL_KEY = 'sw-canvaskit-local';

/** Whether this tab session is pinned to the local engine. */
function isPinnedToLocal(): boolean {
  try {
    return sessionStorage.getItem(CANVASKIT_LOCAL_KEY) !== null;
  } catch {
    // Blocked storage: nothing could have been remembered.
    return false;
  }
}

/**
 * Pin this tab session to the local engine.
 *
 * @returns `'set'` when the flag was written now, `'already-set'` when an
 *   earlier load in this session wrote it, `'unavailable'` when
 *   sessionStorage cannot be used.
 */
function pinToLocal(reason: string): 'set' | 'already-set' | 'unavailable' {
  try {
    if (sessionStorage.getItem(CANVASKIT_LOCAL_KEY) !== null) {
      return 'already-set';
    }
    sessionStorage.setItem(CANVASKIT_LOCAL_KEY, reason.slice(0, 200) || '1');
    return 'set';
  } catch {
    return 'unavailable';
  }
}

/**
 * Recover from an app load that failed with the engine served from the
 * CDN: pin the session to the local engine and reload once.
 *
 * The CDN probe only fetches one byte of the variant's `.js`; a proxy or
 * blocker that strips the `.wasm` passes it and then fails the engine. The
 * Flutter loader is not safely re-entrant within one page, so the retry is
 * a reload rather than a second `load()` call.
 *
 * Loop-proof: the flag outlives the reload, so the next load goes local
 * without probing and never reaches this path with a CDN base. If the flag
 * is somehow already set, or sessionStorage is unavailable (no way to
 * guarantee a single reload), nothing happens and the caller shows the
 * error as before.
 *
 * @returns `true` when a reload was started.
 */
export function reloadWithLocalCanvasKit(reason: string): boolean {
  const result = pinToLocal(`app load failed: ${reason}`);
  if (result !== 'set') {
    logPhase(
      'CanvasKit',
      `App failed with the CDN engine (${reason}); not reloading: ` +
        (result === 'already-set'
          ? 'local engine already forced this session'
          : 'sessionStorage unavailable, cannot guarantee a single reload'),
    );
    return false;
  }
  logPhase(
    'CanvasKit',
    `App failed with the CDN engine (${reason}); reloading once with the local engine`,
  );
  window.location.reload();
  return true;
}

/** Budget for each probe `isCdnEngineFailure` makes after a failed load. */
const FAILURE_PROBE_TIMEOUT_MS = 5000;

/**
 * Decide whether an app load that failed with the engine served from
 * [cdnBase] failed *because of* the CDN engine, and whether a reload onto
 * the local engine can work.
 *
 * Most failures are not the engine's: a `main.dart.js` 404 during a deploy
 * race, a network blip, or an engine/app mismatch
 * (`WebAssembly.instantiate(): Import #N`) fail the same way on the local
 * engine. Reloading for those only hides the error screen and its reset
 * button, and with the origin unreachable it reloads into a blank page,
 * since `bootstrap.js` is never cached.
 *
 * The errors rarely say which file failed. A dynamic `import()` names its
 * URL in Chromium and Firefox, a failed `<script>` rejects with its error
 * event, but a failed engine `.wasm` fetch surfaces as an Emscripten abort
 * with no URL at all. So:
 *
 *  - offline (`navigator.onLine === false`): never;
 *  - the error names a URL under [cdnBase]: the CDN engine is implicated;
 *  - it names any other URL: it is not;
 *  - it names none: the CDN engine is implicated if its `.wasm` (the file
 *    the load-time probe never checked) cannot be fetched now.
 *
 * An implicated CDN still only counts when the origin answers for the
 * local engine, which the reload will load instead.
 *
 * Never throws; any doubt resolves `false`, which shows the error.
 */
export async function isCdnEngineFailure(
  error: unknown,
  cdnBase: string,
  variant: { jsFile: string; wasmFile: string },
): Promise<boolean> {
  try {
    if (navigator.onLine === false) {
      logPhase('CanvasKit', 'App failed while offline; not retrying with the local engine');
      return false;
    }

    const text = failureText(error);
    let implicated: boolean;
    if (text.includes(cdnBase)) {
      implicated = true;
    } else if (/\bhttps?:\/\//.test(text)) {
      implicated = false;
    } else {
      implicated = !(await isReachable(`${cdnBase}/${variant.wasmFile}`));
    }
    if (!implicated) {
      logPhase('CanvasKit', 'App failure does not involve the CDN engine; not retrying with the local engine');
      return false;
    }

    const localUrl = new URL(
      `${CANVASKIT_LOCAL_PATH}/${variant.wasmFile}`,
      document.baseURI,
    ).href;
    if (!(await isReachable(localUrl))) {
      logPhase('CanvasKit', 'Local engine is unreachable too; not reloading');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * What a load failure says about its source: an error's message (and its
 * cause's), or the URL of the element whose error event rejected it.
 */
function failureText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` ${error.cause.message}` : '';
    return `${error.message}${cause}`;
  }
  if (typeof Event !== 'undefined' && error instanceof Event) {
    const target = error.target as { src?: unknown; href?: unknown } | null;
    const url = target?.src ?? target?.href;
    return typeof url === 'string' ? url : '';
  }
  return String(error);
}

/**
 * One-byte `no-store` GET of [url]: a Range request, so the service worker
 * passes it to the network rather than answering from its cache.
 */
async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      new Request(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store',
      }),
      FAILURE_PROBE_TIMEOUT_MS,
    );
    await response.arrayBuffer().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Browser capabilities relevant for CanvasKit variant selection.
 */
interface BrowserCaps {
  hasImageCodecs: boolean;
  hasChromiumBreakIterators: boolean;
  supportsWasmGC: boolean;
  crossOriginIsolated: boolean;
  webGLVersion: number;
}

/**
 * Detect browser capabilities for renderer selection.
 */
export function detectBrowserCaps(): BrowserCaps {
  const browserEngine = detectBrowserEngine();
  return {
    hasImageCodecs:
      browserEngine === 'blink' && typeof ImageDecoder !== 'undefined',
    hasChromiumBreakIterators:
      typeof Intl !== 'undefined' &&
      'v8BreakIterator' in Intl &&
      'Segmenter' in Intl,
    supportsWasmGC: testWasmGC(),
    crossOriginIsolated: !!window.crossOriginIsolated,
    webGLVersion: detectWebGLVersion(),
  };
}

/**
 * Select the active build entry based on browser capabilities.
 */
export function selectBuild(
  builds: FlutterBuildEntry[],
  caps: BrowserCaps,
): FlutterBuildEntry | null {
  // Filter builds compatible with this browser
  for (const build of builds) {
    if (!build.compileTarget && !build.renderer) continue;
    if (build.compileTarget === 'dart2wasm' && !caps.supportsWasmGC) continue;
    if (build.renderer === 'skwasm' && (!caps.supportsWasmGC || caps.webGLVersion < 1))
      continue;
    return build;
  }
  // Fallback to first build with a compile target
  return builds.find((b) => b.compileTarget) ?? null;
}

/**
 * Determine which CanvasKit variant files to load based on build entry and browser.
 */
export function getCanvasKitVariant(
  build: FlutterBuildEntry,
  caps: BrowserCaps,
): { jsFile: string; wasmFile: string } {
  if (build.renderer === 'skwasm') {
    let variant = 'skwasm';
    if (!caps.hasImageCodecs || !caps.hasChromiumBreakIterators) {
      variant = 'skwasm_heavy';
    }
    return { jsFile: `${variant}.js`, wasmFile: `${variant}.wasm` };
  }

  // canvaskit renderer
  const useChromium = caps.hasChromiumBreakIterators && caps.hasImageCodecs;
  if (useChromium) {
    return {
      jsFile: 'chromium/canvaskit.js',
      wasmFile: 'chromium/canvaskit.wasm',
    };
  }
  return { jsFile: 'canvaskit.js', wasmFile: 'canvaskit.wasm' };
}

/**
 * Load CanvasKit: try CDN first, fall back to local.
 *
 * With [useLocalCanvasKit] (the app was built with
 * `--no-web-resources-cdn`) the local directory is used straight away. The
 * CDN probe is a `no-store` request, so it would otherwise cost a network
 * round trip on every load, and up to two 8 s timeouts where gstatic.com
 * is blocked, only to load the engine from somewhere the app chose not to.
 */
export async function loadCanvasKit(
  engineRevision: string,
  build: FlutterBuildEntry,
  caps: BrowserCaps,
  useLocalCanvasKit = false,
): Promise<string> {
  if (useLocalCanvasKit) {
    logPhase(
      'CanvasKit',
      `Using local: ${CANVASKIT_LOCAL_PATH}/ (built with --no-web-resources-cdn)`,
    );
    return CANVASKIT_LOCAL_PATH;
  }

  const variant = getCanvasKitVariant(build, caps);

  if (engineRevision && isPinnedToLocal()) {
    logPhase(
      'CanvasKit',
      `Using local: ${CANVASKIT_LOCAL_PATH}/ (CDN failed earlier in this tab session)`,
    );
    return CANVASKIT_LOCAL_PATH;
  }

  // Try CDN first
  if (engineRevision) {
    const cdnBase = `${CANVASKIT_CDN_BASE}/${engineRevision}`;
    const cdnJsUrl = `${cdnBase}/${variant.jsFile}`;

    try {
      logPhase('CanvasKit', `Probing CDN: ${cdnJsUrl}`);
      // Range GET over HEAD: Chromium devtools mark HEAD cross-origin fetches
      // as net::ERR_ABORTED even on 200 because the body stream is never
      // finalized. Range bytes=0-0 returns a one-byte 206 that we drain with
      // arrayBuffer(), so the fetch closes cleanly and DevTools stays quiet.
      const response = await fetchWithRetry(
        new Request(cdnJsUrl, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          cache: 'no-store',
        }),
        2,
        8000,
      );
      if (response.ok) {
        await response.arrayBuffer();
        logPhase('CanvasKit', 'CDN available');
        return cdnBase;
      }
      rememberProbeFailure(`HTTP ${response.status}`);
    } catch (error) {
      logPhase('CanvasKit', 'CDN failed, falling back to local');
      rememberProbeFailure(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Fallback to local
  logPhase('CanvasKit', `Using local: ${CANVASKIT_LOCAL_PATH}/`);
  return CANVASKIT_LOCAL_PATH;
}

/**
 * Remember a failed CDN probe so later loads in this tab session skip it:
 * where gstatic.com is blocked the probe costs up to two 8 s timeouts.
 */
function rememberProbeFailure(reason: string): void {
  const result = pinToLocal(`CDN probe failed: ${reason}`);
  logPhase(
    'CanvasKit',
    `CDN probe failed (${reason}); ` +
      (result === 'unavailable'
        ? 'sessionStorage unavailable, will probe again next load'
        : 'using local for the rest of this tab session'),
  );
}

function detectBrowserEngine(): 'blink' | 'webkit' | 'gecko' | 'unknown' {
  if (
    navigator.vendor === 'Google Inc.' ||
    navigator.userAgent.includes('Edg/')
  )
    return 'blink';
  if (navigator.vendor === 'Apple Computer, Inc.') return 'webkit';
  if (navigator.vendor === '' && navigator.userAgent.includes('Firefox'))
    return 'gecko';
  return 'unknown';
}

function testWasmGC(): boolean {
  try {
    const bytes = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 95, 1, 120, 0,
    ]);
    return WebAssembly.validate(bytes);
  } catch {
    return false;
  }
}

function detectWebGLVersion(): number {
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    if (canvas.getContext('webgl2')) return 2;
    if (canvas.getContext('webgl')) return 1;
  } catch {
    // ignore
  } finally {
    // Force-release the WebGL context + the canvas element itself so the
    // GPU-backed resources can be reclaimed immediately instead of waiting
    // for GC.
    if (canvas) {
      try {
        const ctx =
          canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const loseCtx = (
          ctx as WebGLRenderingContext | null
        )?.getExtension('WEBGL_lose_context');
        loseCtx?.loseContext();
      } catch {
        // ignore
      }
    }
  }
  return -1;
}
