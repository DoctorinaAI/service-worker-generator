/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runPipeline } from '../pipeline';
import type { ResolvedConfig } from '../config';
import { BootstrapAPI } from '../api';
import {
  listenForSWMessages,
  registerServiceWorker,
  reloadIfForeignController,
  settleUpdateAtBootstrap,
} from '../sw-registration';
import { loadCanvasKit, reloadWithLocalCanvasKit } from '../canvaskit-loader';
import { LoadingWidget } from '../loading-widget';
import { CANVASKIT_LOCAL_PATH } from '../../shared/constants';
import { FlutterLoaderMissingError, loadFlutterApp } from '../flutter-loader';
import type { SWProgressMessage } from '../../shared/types';

// Mock all side-effecty modules so runPipeline runs synchronously-as-possible
// and we can observe calls without performing real registration or fetches.
vi.mock('../sw-registration', () => ({
  registerServiceWorker: vi.fn(async () => null),
  listenForSWMessages: vi.fn(() => () => undefined),
  reloadIfForeignController: vi.fn(async () => false),
  settleUpdateAtBootstrap: vi.fn(async () => false),
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
  reloadWithLocalCanvasKit: vi.fn(() => false),
}));
vi.mock('../flutter-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../flutter-loader')>()),
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

  it('tells the CanvasKit loader to stay local for --no-web-resources-cdn builds', async () => {
    const load = vi.mocked(loadCanvasKit);
    load.mockClear();
    const cfg = resolved();
    cfg.build.useLocalCanvasKit = true;
    runPipeline(cfg);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(load).toHaveBeenCalledWith(
      'rev',
      cfg.build.builds[0],
      expect.anything(),
      true,
    );
  });

  it('lets the CanvasKit loader try the CDN when useLocalCanvasKit is absent', async () => {
    const load = vi.mocked(loadCanvasKit);
    load.mockClear();
    const cfg = resolved();
    runPipeline(cfg);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(load).toHaveBeenCalledWith(
      'rev',
      cfg.build.builds[0],
      expect.anything(),
      false,
    );
  });

  it('stops before loading the engine when the page reloads for an update', async () => {
    // The previous build's worker would serve its Dart code to this
    // build's engine; the reload lands the page on the new worker.
    const registration = {} as ServiceWorkerRegistration;
    vi.mocked(registerServiceWorker).mockResolvedValueOnce(registration);
    vi.mocked(settleUpdateAtBootstrap).mockResolvedValueOnce(true);
    const load = vi.mocked(loadCanvasKit);
    load.mockClear();
    runPipeline(resolved());
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(settleUpdateAtBootstrap).toHaveBeenCalledWith(registration, 'rev');
    expect(load).not.toHaveBeenCalled();
  });

  it('stops before registering when the page reloads off a foreign controller', async () => {
    // Registering, or loading anything, would race the navigation the
    // recovery has just started.
    vi.mocked(reloadIfForeignController).mockResolvedValueOnce(true);
    const register = vi.mocked(registerServiceWorker);
    register.mockClear();
    const load = vi.mocked(loadFlutterApp);
    load.mockClear();

    const api = runPipeline(resolved());
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(register).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    // The widget stays up until the page goes away.
    expect(api.disposed).toBe(false);
  });

  it('boots without the update check when there is no registration', async () => {
    // Unsupported, failed, or out of time: nothing to settle, and the app
    // still has to start.
    vi.mocked(registerServiceWorker).mockResolvedValueOnce(null);
    const settleSpy = vi.mocked(settleUpdateAtBootstrap);
    settleSpy.mockClear();
    const load = vi.mocked(loadFlutterApp);
    load.mockClear();

    runPipeline(resolved());
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(settleSpy).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
  });

  it('boots after the update check decides not to reload', async () => {
    vi.mocked(registerServiceWorker).mockResolvedValueOnce({} as ServiceWorkerRegistration);
    vi.mocked(settleUpdateAtBootstrap).mockResolvedValueOnce(false);
    const load = vi.mocked(loadFlutterApp);
    load.mockClear();

    runPipeline(resolved());
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(load).toHaveBeenCalledWith(
      '/cdn/base',
      'rev',
      resolved().build.builds,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('forwards the Flutter loader\'s progress into the widget range', async () => {
    vi.mocked(loadFlutterApp).mockImplementationOnce(async (_base, _rev, _builds, onProgress) => {
      onProgress(100, 'Starting application');
    });
    const cfg = resolved();
    const api = runPipeline(cfg);
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(api.progress.phase).toBe('dart-entry');
    expect(api.progress.message).toBe('Starting application');
    expect(api.progress.percent).toBe(cfg.ui.maxProgress);
  });

  it('shows a generic error when the loader rejects with a non-Error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(loadFlutterApp).mockRejectedValueOnce('boom');
    const api = runPipeline(resolved());
    const errSpy = vi.spyOn(api, 'error');
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(errSpy).toHaveBeenCalledWith('Failed to load application');
    expect(api.disposed).toBe(false);
    errorSpy.mockRestore();
  });

  it('auto-disposes the API when flutter-first-frame is dispatched', async () => {
    const api = runPipeline(resolved());
    for (let i = 0; i < 30; i++) await Promise.resolve();
    window.dispatchEvent(new Event('flutter-first-frame'));
    expect(api.disposed).toBe(true);
  });

  it('disposes on a first frame dispatched before the app loader resolves', async () => {
    // Flutter can render its first frame while `loadFlutterApp` is still
    // awaiting the entrypoint; a listener added afterwards misses it.
    vi.mocked(loadFlutterApp).mockImplementationOnce(async () => {
      window.dispatchEvent(new Event('flutter-first-frame'));
    });
    const api = runPipeline(resolved());
    for (let i = 0; i < 30; i++) await Promise.resolve();
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

describe('runPipeline — CDN engine fallback', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let listenerTracker: ReturnType<typeof trackWindowListeners>;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listenerTracker = trackWindowListeners();
    vi.mocked(reloadWithLocalCanvasKit).mockClear();
    vi.mocked(reloadWithLocalCanvasKit).mockReturnValue(false);
  });

  afterEach(() => {
    listenerTracker.restore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.mocked(loadCanvasKit).mockReset();
    vi.mocked(loadCanvasKit).mockImplementation(async () => '/cdn/base');
    vi.mocked(loadFlutterApp).mockReset();
    vi.mocked(loadFlutterApp).mockImplementation(async () => undefined);
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  }

  it('reloads with the local engine when the app fails on a CDN engine', async () => {
    vi.mocked(reloadWithLocalCanvasKit).mockReturnValue(true);
    vi.mocked(loadFlutterApp).mockRejectedValueOnce(new Error('wasm blocked'));
    const api = runPipeline(resolved());
    const errSpy = vi.spyOn(api, 'error');
    await settle();
    expect(reloadWithLocalCanvasKit).toHaveBeenCalledOnce();
    expect(String(vi.mocked(reloadWithLocalCanvasKit).mock.calls[0][0])).toContain(
      'wasm blocked',
    );
    // The page is going away; no error flash on the way out.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('shows the error as before when the reload is declined', async () => {
    vi.mocked(reloadWithLocalCanvasKit).mockReturnValue(false);
    vi.mocked(loadFlutterApp).mockRejectedValueOnce(new Error('wasm blocked'));
    const api = runPipeline(resolved());
    const errSpy = vi.spyOn(api, 'error');
    await settle();
    expect(reloadWithLocalCanvasKit).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledWith('wasm blocked');
  });

  it('does not reload for a missing Flutter loader, which no engine fixes', async () => {
    vi.mocked(reloadWithLocalCanvasKit).mockReturnValue(true);
    vi.mocked(loadFlutterApp).mockRejectedValueOnce(
      new FlutterLoaderMissingError(),
    );
    const api = runPipeline(resolved());
    const errSpy = vi.spyOn(api, 'error');
    await settle();
    expect(reloadWithLocalCanvasKit).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('_flutter.loader not available'),
    );
  });

  it('does not attempt the fallback when the engine was already local', async () => {
    vi.mocked(loadCanvasKit).mockResolvedValueOnce(CANVASKIT_LOCAL_PATH);
    vi.mocked(loadFlutterApp).mockRejectedValueOnce(new Error('broken'));
    const api = runPipeline(resolved());
    const errSpy = vi.spyOn(api, 'error');
    await settle();
    expect(reloadWithLocalCanvasKit).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('broken');
  });

  it('does not attempt the fallback for errors before the app loads', async () => {
    const cfg = resolved();
    cfg.build.builds = [];
    runPipeline(cfg);
    await settle();
    expect(reloadWithLocalCanvasKit).not.toHaveBeenCalled();
  });

  it('handles an engine initialisation failure reported by the loader', async () => {
    // With the callback form of flutter.loader.load, initializeEngine runs
    // inside onEntrypointLoaded, whose rejection never reaches load().
    vi.mocked(reloadWithLocalCanvasKit).mockReturnValue(false);
    vi.mocked(loadFlutterApp).mockImplementationOnce(
      async (_b, _r, _builds, _p, onEngineError) => {
        onEngineError?.(new Error('canvaskit.wasm 403'));
      },
    );
    const api = runPipeline(resolved());
    const errSpy = vi.spyOn(api, 'error');
    await settle();
    expect(reloadWithLocalCanvasKit).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledWith('canvaskit.wasm 403');
  });

  it('handles one failure only once when both paths report it', async () => {
    vi.mocked(loadFlutterApp).mockImplementationOnce(
      async (_b, _r, _builds, _p, onEngineError) => {
        const e = new Error('dup');
        onEngineError?.(e);
        throw e;
      },
    );
    const api = runPipeline(resolved());
    const errSpy = vi.spyOn(api, 'error');
    await settle();
    expect(reloadWithLocalCanvasKit).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledOnce();
  });
});

describe('runPipeline — reset scope', () => {
  it('hands the build\'s cache prefix to the widget', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const tracker = trackWindowListeners();
    try {
      const cfg = resolved();
      cfg.build.cachePrefix = 'my-app';
      const api = runPipeline(cfg);
      const widget = (api as unknown as { widget: { cachePrefix?: string } }).widget;
      expect(widget.cachePrefix).toBe('my-app');
    } finally {
      tracker.restore();
      spy.mockRestore();
    }
  });
});

describe('runPipeline — widget failures never block the app', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let listenerTracker: ReturnType<typeof trackWindowListeners>;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listenerTracker = trackWindowListeners();
  });

  afterEach(() => {
    listenerTracker.restore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('still loads Flutter when the widget mount throws', async () => {
    vi.spyOn(LoadingWidget.prototype, 'mount').mockImplementation(() => {
      throw new Error('Trusted Types');
    });
    const load = vi.mocked(loadFlutterApp);
    load.mockClear();
    let api: BootstrapAPI | undefined;
    expect(() => {
      api = runPipeline(resolved());
    }).not.toThrow();
    expect(api).toBeInstanceOf(BootstrapAPI);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('still loads Flutter when a progress update throws in the widget', async () => {
    vi.spyOn(LoadingWidget.prototype, 'updateProgress').mockImplementation(() => {
      throw new Error('render');
    });
    const load = vi.mocked(loadFlutterApp);
    load.mockClear();
    const api = runPipeline(resolved());
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    // The API state still advances for subscribers.
    expect(api.progress.phase).not.toBe('init');
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

  /** Let the mocked pipeline run to its `finally`. */
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

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

  it('clamps when two builds report under one pinned version', () => {
    // The version filter separates workers by identity, so it cannot help
    // when a caller pins `--version` to a constant across builds: two
    // different counted sets arrive under the same name, the denominator
    // is latched from whoever spoke first, and their union outruns it.
    // This is the original "Loaded 5 of 4" shape, reached the only way it
    // still can be.
    const { api, send } = startAndCapture();
    for (const key of ['a', 'b', 'c', 'd']) send({ resourceKey: key });
    expect(api.progress.message).toBe('Loaded 4 of 4 resources');

    send({ resourceKey: 'e', resourcesCount: 9 });
    expect(api.progress.message).toBe('Loaded 4 of 4 resources');
  });

  it('stays quiet about a foreign worker on a healthy update load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { send } = startAndCapture();
    // The outgoing controller talks first; the installing worker answers.
    send({ resourceKey: 'version.json', swVersion: 'v0', resourcesCount: 9 });
    send({ resourceKey: 'main.dart.wasm' });
    await settle();

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('No sw-progress'),
    );
  });

  it('reports at teardown when every message came from another build', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api, send } = startAndCapture();
    send({ resourceKey: 'main.dart.wasm', swVersion: 'v0', resourcesCount: 9 });
    send({ resourceKey: 'manifest.json', swVersion: 'v0', resourcesCount: 9 });
    await settle();

    // Nothing was countable, so the counter never rendered...
    expect(api.progress.message).not.toContain('resources');
    // ...and the reason is said once, after it is knowable.
    const messages = warn.mock.calls.map((call) => String(call[0]));
    const reports = messages.filter((m) => m.includes('No sw-progress'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('v0');
  });

  it('does not count in-flight or failed resources', () => {
    const { api, send } = startAndCapture();
    send({ resourceKey: 'main.dart.wasm', status: 'loading', loaded: 0 });
    send({ resourceKey: 'manifest.json', status: 'error' });
    expect(api.progress.message).toBe('Loaded 0 of 4 resources');
  });
});
