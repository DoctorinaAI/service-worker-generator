import type { FlutterBuildEntry } from '../shared/types';
import { CANVASKIT_CDN_BASE, CANVASKIT_LOCAL_PATH } from '../shared/constants';
import { fetchWithRetry } from '../shared/utils';
import { logPhase } from './console-logger';

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
      jsFile: 'canvaskit.js',
      wasmFile: 'chromium/canvaskit.wasm',
    };
  }
  return { jsFile: 'canvaskit.js', wasmFile: 'canvaskit.wasm' };
}

/**
 * Load CanvasKit: try CDN first, fall back to local.
 */
export async function loadCanvasKit(
  engineRevision: string,
  build: FlutterBuildEntry,
  caps: BrowserCaps,
): Promise<string> {
  const variant = getCanvasKitVariant(build, caps);

  // Try CDN first
  if (engineRevision) {
    const cdnBase = `${CANVASKIT_CDN_BASE}/${engineRevision}`;
    const cdnJsUrl = `${cdnBase}/${variant.jsFile}`;

    try {
      logPhase('CanvasKit', `Probing CDN: ${cdnJsUrl}`);
      // HEAD avoids downloading the full canvaskit.js just to check
      // availability — Flutter's loader will fetch it for real via <script>.
      const response = await fetchWithRetry(
        new Request(cdnJsUrl, { method: 'HEAD' }),
        2,
        8000,
      );
      if (response.ok) {
        logPhase('CanvasKit', 'CDN available');
        return cdnBase;
      }
    } catch {
      logPhase('CanvasKit', 'CDN failed, falling back to local');
    }
  }

  // Fallback to local
  logPhase('CanvasKit', `Using local: ${CANVASKIT_LOCAL_PATH}/`);
  return CANVASKIT_LOCAL_PATH;
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
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    if (canvas.getContext('webgl2')) return 2;
    if (canvas.getContext('webgl')) return 1;
  } catch {
    // ignore
  }
  return -1;
}
