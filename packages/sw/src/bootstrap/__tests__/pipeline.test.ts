/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runPipeline } from '../pipeline';
import type { ResolvedConfig } from '../config';
import { BootstrapAPI } from '../api';
import { listenForSWMessages } from '../sw-registration';
import type { SWProgressMessage } from '../../shared/types';

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

describe('runPipeline — SW progress counter', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let listenerTracker: ReturnType<typeof trackWindowListeners>;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    listenerTracker = trackWindowListeners();
    // The pipeline only subscribes to SW progress when the API exists;
    // jsdom has no serviceWorker container.
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {},
      configurable: true,
    });
  });

  afterEach(() => {
    listenerTracker.restore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  });

  /**
   * Start the pipeline and hand back the callback it registered with
   * `listenForSWMessages`, so tests can play SW messages into it directly.
   */
  function startAndCapture(): {
    api: BootstrapAPI;
    send: (msg: Partial<SWProgressMessage>) => void;
  } {
    const listen = vi.mocked(listenForSWMessages);
    listen.mockClear();
    const api = runPipeline(resolved());
    const callback = listen.mock.calls[0]![0] as (data: unknown) => void;
    const send = (msg: Partial<SWProgressMessage>): void =>
      callback({
        type: 'sw-progress',
        timestamp: 0,
        swVersion: 'v1',
        resourcesSize: 400,
        resourcesCount: 4,
        resourceName: '',
        resourceUrl: '',
        resourceKey: '',
        resourceSize: 100,
        loaded: 100,
        status: 'completed',
        counted: true,
        ...msg,
      } satisfies SWProgressMessage);
    return { api, send };
  }

  it('counts pre-cached resources up to the reported total', () => {
    const { api, send } = startAndCapture();
    send({ resourceKey: 'main.dart.wasm' });
    expect(api.progress.message).toBe('Loaded 1 of 4 resources');
    send({ resourceKey: 'assets/FontManifest.json' });
    expect(api.progress.message).toBe('Loaded 2 of 4 resources');
  });

  it('ignores resources outside the counted set', () => {
    const { api, send } = startAndCapture();
    send({ resourceKey: 'main.dart.wasm' });
    // A font served by the fetch handler: reported, lazily cached, but not
    // part of `resourcesCount`. Counting it produced "Loaded 5 of 4".
    send({ resourceKey: 'assets/fonts/Inter.ttf', counted: false });
    send({ resourceKey: 'icons/icon-192.png', counted: false });
    expect(api.progress.message).toBe('Loaded 1 of 4 resources');
  });

  it('ignores progress from a worker of another version', () => {
    const { api, send } = startAndCapture();
    send({ resourceKey: 'main.dart.wasm' });
    // The old controller during an update load: its manifest, its totals.
    send({ resourceKey: 'version.json', swVersion: 'v0', resourcesCount: 9 });
    expect(api.progress.message).toBe('Loaded 1 of 4 resources');
  });

  it('keeps the denominator fixed for the whole load', () => {
    const { api, send } = startAndCapture();
    send({ resourceKey: 'main.dart.wasm' });
    send({ resourceKey: 'manifest.json', resourcesCount: 99 });
    expect(api.progress.message).toBe('Loaded 2 of 4 resources');
  });

  it('never renders a count above the total, and does not double-count', () => {
    const { api, send } = startAndCapture();
    for (const key of ['a', 'b', 'c', 'd', 'a', 'b']) {
      send({ resourceKey: key });
    }
    expect(api.progress.message).toBe('Loaded 4 of 4 resources');
  });

  it('does not count in-flight or failed resources', () => {
    const { api, send } = startAndCapture();
    send({ resourceKey: 'main.dart.wasm', status: 'loading', loaded: 0 });
    send({ resourceKey: 'manifest.json', status: 'error' });
    expect(api.progress.message).toBe('Loaded 0 of 4 resources');
  });
});
