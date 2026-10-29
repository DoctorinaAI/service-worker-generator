/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectBrowserCaps,
  selectBuild,
  getCanvasKitVariant,
  loadCanvasKit,
} from '../canvaskit-loader';
import type { FlutterBuildEntry } from '../../shared/types';
import {
  CANVASKIT_CDN_BASE,
  CANVASKIT_LOCAL_PATH,
} from '../../shared/constants';
import { installMockFetch, textResponse } from '../../__tests__/helpers';

type Caps = ReturnType<typeof detectBrowserCaps>;

function caps(overrides: Partial<Caps> = {}): Caps {
  return {
    hasImageCodecs: false,
    hasChromiumBreakIterators: false,
    supportsWasmGC: false,
    crossOriginIsolated: false,
    webGLVersion: 2,
    ...overrides,
  };
}

describe('detectBrowserCaps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a well-formed shape (all expected keys)', () => {
    const result = detectBrowserCaps();
    expect(result).toHaveProperty('hasImageCodecs');
    expect(result).toHaveProperty('hasChromiumBreakIterators');
    expect(result).toHaveProperty('supportsWasmGC');
    expect(result).toHaveProperty('crossOriginIsolated');
    expect(result).toHaveProperty('webGLVersion');
  });

  it('reports crossOriginIsolated from window', () => {
    Object.defineProperty(window, 'crossOriginIsolated', {
      configurable: true,
      value: true,
    });
    expect(detectBrowserCaps().crossOriginIsolated).toBe(true);

    Object.defineProperty(window, 'crossOriginIsolated', {
      configurable: true,
      value: false,
    });
    expect(detectBrowserCaps().crossOriginIsolated).toBe(false);
  });
});

describe('detectBrowserCaps — browser engine', () => {
  function pretend(vendor: string, userAgent: string): void {
    Object.defineProperty(navigator, 'vendor', { configurable: true, get: () => vendor });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => userAgent });
  }

  beforeEach(() => {
    // Image codecs need both a Blink engine and the API; provide the API so
    // the engine decides.
    (globalThis as unknown as { ImageDecoder?: unknown }).ImageDecoder = class {};
  });

  afterEach(() => {
    delete (navigator as unknown as { vendor?: unknown }).vendor;
    // Drops the own-property overrides, exposing jsdom's getters again.
    delete (navigator as unknown as { userAgent?: unknown }).userAgent;
    delete (globalThis as unknown as { ImageDecoder?: unknown }).ImageDecoder;
    vi.restoreAllMocks();
  });

  it('uses image codecs on Chrome', () => {
    pretend('Google Inc.', 'Mozilla/5.0 Chrome/130.0');
    expect(detectBrowserCaps().hasImageCodecs).toBe(true);
  });

  it('uses image codecs on Edge', () => {
    pretend('', 'Mozilla/5.0 Chrome/130.0 Edg/130.0');
    expect(detectBrowserCaps().hasImageCodecs).toBe(true);
  });

  it('does not use image codecs on Safari, even where ImageDecoder exists', () => {
    pretend('Apple Computer, Inc.', 'Mozilla/5.0 Version/18.0 Safari/605.1.15');
    expect(detectBrowserCaps().hasImageCodecs).toBe(false);
  });

  it('does not use image codecs on Firefox', () => {
    pretend('', 'Mozilla/5.0 Gecko/20100101 Firefox/133.0');
    expect(detectBrowserCaps().hasImageCodecs).toBe(false);
  });

  it('does not use image codecs on an unknown engine', () => {
    pretend('Some Vendor', 'Mozilla/5.0');
    expect(detectBrowserCaps().hasImageCodecs).toBe(false);
  });

  it('reports no WasmGC when WebAssembly validation throws', () => {
    // A locked-down WebView can expose WebAssembly and still refuse to use it.
    vi.spyOn(WebAssembly, 'validate').mockImplementation(() => {
      throw new Error('disabled');
    });
    expect(detectBrowserCaps().supportsWasmGC).toBe(false);
  });
});

describe('selectBuild', () => {
  it('returns the first build that has compileTarget or renderer', () => {
    const builds: FlutterBuildEntry[] = [
      {},
      { compileTarget: 'dart2js' },
    ];
    expect(selectBuild(builds, caps())).toEqual({ compileTarget: 'dart2js' });
  });

  it('skips dart2wasm when WasmGC is unsupported', () => {
    const builds: FlutterBuildEntry[] = [
      { compileTarget: 'dart2wasm' },
      { compileTarget: 'dart2js' },
    ];
    expect(selectBuild(builds, caps({ supportsWasmGC: false })))
      .toEqual({ compileTarget: 'dart2js' });
  });

  it('selects dart2wasm when WasmGC is supported', () => {
    const builds: FlutterBuildEntry[] = [
      { compileTarget: 'dart2wasm' },
      { compileTarget: 'dart2js' },
    ];
    expect(selectBuild(builds, caps({ supportsWasmGC: true })))
      .toEqual({ compileTarget: 'dart2wasm' });
  });

  it('skips skwasm renderer when WasmGC unsupported', () => {
    const builds: FlutterBuildEntry[] = [
      { renderer: 'skwasm' },
      { renderer: 'canvaskit' },
    ];
    expect(selectBuild(builds, caps({ supportsWasmGC: false })))
      .toEqual({ renderer: 'canvaskit' });
  });

  it('skips skwasm renderer when webGLVersion < 1', () => {
    const builds: FlutterBuildEntry[] = [
      { renderer: 'skwasm' },
      { renderer: 'canvaskit' },
    ];
    expect(
      selectBuild(builds, caps({ supportsWasmGC: true, webGLVersion: -1 })),
    ).toEqual({ renderer: 'canvaskit' });
  });

  it('returns first build with compileTarget as fallback when nothing matches', () => {
    const builds: FlutterBuildEntry[] = [
      { renderer: 'skwasm' },
      { compileTarget: 'dart2wasm' },
    ];
    // Neither matches under these caps; fallback to first compileTarget.
    expect(
      selectBuild(builds, caps({ supportsWasmGC: false, webGLVersion: -1 })),
    ).toEqual({ compileTarget: 'dart2wasm' });
  });

  it('returns null when there are no viable builds', () => {
    expect(selectBuild([{}], caps())).toBeNull();
    expect(selectBuild([], caps())).toBeNull();
  });
});

describe('getCanvasKitVariant', () => {
  it('picks skwasm variant when renderer is skwasm', () => {
    const result = getCanvasKitVariant(
      { renderer: 'skwasm' },
      caps({ hasImageCodecs: true, hasChromiumBreakIterators: true }),
    );
    expect(result).toEqual({ jsFile: 'skwasm.js', wasmFile: 'skwasm.wasm' });
  });

  it('picks skwasm_heavy on non-chromium browsers', () => {
    const result = getCanvasKitVariant(
      { renderer: 'skwasm' },
      caps({ hasImageCodecs: false, hasChromiumBreakIterators: false }),
    );
    expect(result).toEqual({
      jsFile: 'skwasm_heavy.js',
      wasmFile: 'skwasm_heavy.wasm',
    });
  });

  it('uses chromium canvaskit for chromium-class browsers', () => {
    const result = getCanvasKitVariant(
      { renderer: 'canvaskit' },
      caps({ hasImageCodecs: true, hasChromiumBreakIterators: true }),
    );
    expect(result).toEqual({
      jsFile: 'chromium/canvaskit.js',
      wasmFile: 'chromium/canvaskit.wasm',
    });
  });

  it('uses standard canvaskit on non-chromium browsers', () => {
    const result = getCanvasKitVariant(
      { renderer: 'canvaskit' },
      caps(),
    );
    expect(result).toEqual({
      jsFile: 'canvaskit.js',
      wasmFile: 'canvaskit.wasm',
    });
  });
});

describe('loadCanvasKit', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('returns the CDN base when probe succeeds', async () => {
    const spy = installMockFetch(async () => textResponse('ok'));
    const result = await loadCanvasKit(
      'engine-rev-123',
      { renderer: 'canvaskit' },
      caps(),
    );
    expect(result).toBe(`${CANVASKIT_CDN_BASE}/engine-rev-123`);
    const request = spy.mock.calls[0][0] as Request;
    expect(request.method).toBe('GET');
    expect(request.headers.get('Range')).toBe('bytes=0-0');
    expect(request.url).toContain('engine-rev-123');
  });

  it('uses local without probing the CDN when useLocalCanvasKit is set', async () => {
    const spy = installMockFetch(async () => textResponse('ok'));
    const result = await loadCanvasKit(
      'engine-rev-123',
      { renderer: 'skwasm' },
      caps(),
      true,
    );
    expect(result).toBe(CANVASKIT_LOCAL_PATH);
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to local when CDN returns non-ok', async () => {
    installMockFetch(async () => textResponse('down', 404));
    const result = await loadCanvasKit(
      'engine-rev-123',
      { renderer: 'canvaskit' },
      caps(),
    );
    expect(result).toBe(CANVASKIT_LOCAL_PATH);
  });

  it('falls back to local when CDN throws', async () => {
    // Collapse retry backoff to zero for fast failure.
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);

    installMockFetch(async () => {
      throw new Error('offline');
    });
    const result = await loadCanvasKit(
      'engine-rev-123',
      { renderer: 'canvaskit' },
      caps(),
    );
    expect(result).toBe(CANVASKIT_LOCAL_PATH);
  });

  it('skips CDN probe and uses local when engineRevision is empty', async () => {
    const spy = installMockFetch(async () => textResponse('ok'));
    const result = await loadCanvasKit(
      '',
      { renderer: 'canvaskit' },
      caps(),
    );
    expect(result).toBe(CANVASKIT_LOCAL_PATH);
    expect(spy).not.toHaveBeenCalled();
  });

  it('probes skwasm JS variant when renderer is skwasm', async () => {
    const spy = installMockFetch(async () => textResponse('ok'));
    await loadCanvasKit(
      'engine-rev',
      { renderer: 'skwasm' },
      caps({ supportsWasmGC: true, hasImageCodecs: true, hasChromiumBreakIterators: true }),
    );
    const url = (spy.mock.calls[0][0] as Request).url;
    expect(url).toContain('skwasm.js');
  });
});
