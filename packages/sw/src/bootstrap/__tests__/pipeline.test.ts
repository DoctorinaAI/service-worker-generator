/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runPipeline } from '../pipeline';
import type { ResolvedConfig } from '../config';
import { BootstrapAPI } from '../api';

// Mock all side-effecty modules so runPipeline runs synchronously-as-possible
// and we can observe calls without performing real registration or fetches.
vi.mock('../sw-registration', () => ({
  registerServiceWorker: vi.fn(async () => null),
  listenForSWMessages: vi.fn(() => () => undefined),
  reloadIfForeignController: vi.fn(async () => false),
}));
vi.mock('../canvaskit-loader', () => ({
  detectBrowserCaps: vi.fn(() => ({
    hasImageCodecs: false,
    hasChromiumBreakIterators: false,
    supportsWasmGC: false,
    crossOriginIsolated: false,
    webGLVersion: 2,
  })),
  selectBuild: vi.fn((builds: unknown[]) => builds[0] ?? null),
  loadCanvasKit: vi.fn(async () => '/cdn/base'),
}));
vi.mock('../flutter-loader', () => ({
  loadFlutterApp: vi.fn(async () => undefined),
}));

function resolved(): ResolvedConfig {
  return {
    build: {
      engineRevision: 'rev',
      swVersion: 'v1',
      swFilename: 'sw.js',
      builds: [{ renderer: 'canvaskit', compileTarget: 'dart2js' }],
    },
    ui: {
      logo: '',
      title: '',
      theme: 'auto',
      color: '#25D366',
      showPercentage: false,
      minProgress: 0,
      maxProgress: 90,
    },
  };
}

// JSDOM stub for matchMedia (LoadingWidget uses it).
if (!window.matchMedia) {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia =
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
}

// Vitest's jsdom environment shares one `window` across every `it()` in a
// file. `runPipeline` installs a permanent (not `{once:true}`) bridge listener
// for `sw-update-available` plus a `flutter-first-frame` listener — both
// would survive into later tests and double-fire handlers from prior cases.
// We track listeners added during each test by spying on
// `window.addEventListener` and remove them in `afterEach`.
type TrackedListener = {
  type: string;
  listener: EventListenerOrEventListenerObject;
};

function trackWindowListeners(): {
  added: TrackedListener[];
  restore: () => void;
} {
  const added: TrackedListener[] = [];
  const original = window.addEventListener.bind(window);
  const spy = vi
    .spyOn(window, 'addEventListener')
    .mockImplementation((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      added.push({ type, listener });
      return original(type, listener, options);
    });
  return {
    added,
    restore: () => {
      for (const { type, listener } of added) {
        window.removeEventListener(type, listener);
      }
      spy.mockRestore();
    },
  };
}

describe('runPipeline', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let listenerTracker: ReturnType<typeof trackWindowListeners>;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    listenerTracker = trackWindowListeners();
  });

  afterEach(() => {
    listenerTracker.restore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
    vi.doUnmock('../sw-registration');
    vi.doUnmock('../canvaskit-loader');
    vi.doUnmock('../flutter-loader');
  });

  it('returns a BootstrapAPI synchronously (no await required)', () => {
    const api = runPipeline(resolved());
    expect(api).toBeInstanceOf(BootstrapAPI);
  });

  it('mounts the loading widget before returning', () => {
    runPipeline(resolved());
    expect(document.getElementById('sw-loading')).not.toBeNull();
  });

  it('initial progress is a synchronous BootstrapAPI (progress defined)', () => {
    const api = runPipeline(resolved());
    // runPipelineWork is fire-and-forget but its sync prefix has already run
    // by the time runPipeline returns, so we just assert the API is live.
    expect(api.progress).toBeDefined();
    expect(typeof api.progress.percent).toBe('number');
    expect(api.disposed).toBe(false);
  });

  it('drives progress through multiple stages as the async work runs', async () => {
    const api = runPipeline(resolved());
    // Let the fire-and-forget pipeline run.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    // By now at least the `init`/`sw` stage should have advanced progress.
    expect(api.progress.percent).toBeGreaterThan(0);
  });

  it('scales progress into [ui.minProgress, ui.maxProgress]', async () => {
    const cfg = resolved();
    cfg.ui.minProgress = 10;
    cfg.ui.maxProgress = 30;
    const api = runPipeline(cfg);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(api.progress.percent).toBeGreaterThanOrEqual(10);
    // Internal STAGE_PROGRESS never exceeds 100 → mapped ≤ 30.
    expect(api.progress.percent).toBeLessThanOrEqual(30);
  });

  it('surfaces a pipeline error to api.error when selectBuild returns null', async () => {
    // Pass empty builds so the default selectBuild mock (returns builds[0] ?? null)
    // returns null — which triggers the error path.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cfg = resolved();
    cfg.build.builds = [];
    const api = runPipeline(cfg);
    const errSpy = vi.spyOn(api, 'error');
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls[0][0];
    expect(String(msg)).toMatch(/No compatible Flutter build/);
    errorSpy.mockRestore();
  });

  it('auto-disposes the API when flutter-first-frame is dispatched', async () => {
    const api = runPipeline(resolved());
    for (let i = 0; i < 30; i++) await Promise.resolve();
    window.dispatchEvent(new Event('flutter-first-frame'));
    expect(api.disposed).toBe(true);
  });

  it('routes sw-update-available to onUpdateAvailable handlers after flutter-first-frame dispose', async () => {
    const api = runPipeline(resolved());
    const handler = vi.fn();
    api.onUpdateAvailable(handler);

    // Let the pipeline progress past sw registration so the bridge listener
    // is definitely installed (it is installed synchronously in runPipeline,
    // but yielding mirrors real ordering).
    for (let i = 0; i < 30; i++) await Promise.resolve();

    window.dispatchEvent(new Event('flutter-first-frame'));
    expect(api.disposed).toBe(true);

    window.dispatchEvent(new CustomEvent('sw-update-available'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('dispatches multiple sw-update-available events without one-shot debounce', async () => {
    const api = runPipeline(resolved());
    const handler = vi.fn();
    api.onUpdateAvailable(handler);

    for (let i = 0; i < 30; i++) await Promise.resolve();

    window.dispatchEvent(new CustomEvent('sw-update-available'));
    window.dispatchEvent(new CustomEvent('sw-update-available'));
    window.dispatchEvent(new CustomEvent('sw-update-available'));

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('accepts late subscriptions registered after dispose and fires them on next event', async () => {
    const api = runPipeline(resolved());
    for (let i = 0; i < 30; i++) await Promise.resolve();
    window.dispatchEvent(new Event('flutter-first-frame'));
    expect(api.disposed).toBe(true);

    // A consumer wiring its handler lazily (e.g., a Dart controller built
    // by a router after the loading widget is gone) must still observe the
    // next SW update.
    const handler = vi.fn();
    api.onUpdateAvailable(handler);
    window.dispatchEvent(new CustomEvent('sw-update-available'));

    expect(handler).toHaveBeenCalledOnce();
  });
});
