/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BootstrapAPI, installGlobalAPI } from '../api';
import type { LoadingWidget } from '../loading-widget';

function makeWidgetStub() {
  return {
    updateProgress: vi.fn(),
    showError: vi.fn(),
    dispose: vi.fn(),
    mount: vi.fn(),
  };
}

describe('BootstrapAPI', () => {
  let widget: ReturnType<typeof makeWidgetStub>;
  let api: BootstrapAPI;

  beforeEach(() => {
    widget = makeWidgetStub();
    api = new BootstrapAPI(widget as unknown as LoadingWidget);
  });

  it('starts at phase=init, percent=0', () => {
    expect(api.progress.phase).toBe('init');
    expect(api.progress.percent).toBe(0);
    expect(api.progress.message).toBe('Initializing');
  });

  it('returns a cloned progress object (no external mutation)', () => {
    const snapshot = api.progress as { percent: number };
    snapshot.percent = 99;
    expect(api.progress.percent).toBe(0);
  });

  it('update() changes state and forwards to the widget', () => {
    api.update('sw', 25, 'registering sw');
    expect(api.progress).toEqual({
      phase: 'sw',
      percent: 25,
      message: 'registering sw',
    });
    expect(widget.updateProgress).toHaveBeenCalledWith(25, 'registering sw');
  });

  it('subscribe receives updates until unsubscribed', () => {
    const cb = vi.fn();
    const unsubscribe = api.subscribe(cb);

    api.update('sw', 10, 'a');
    api.update('sw', 20, 'b');
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith({ phase: 'sw', percent: 20, message: 'b' });

    unsubscribe();
    api.update('sw', 30, 'c');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('subscribe error does not crash the updater', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.subscribe(() => {
      throw new Error('bad subscriber');
    });
    expect(() => api.update('sw', 10, 'go')).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('dispose marks disposed, disposes widget, clears subscribers, retains updateHandlers', () => {
    const progressCb = vi.fn();
    const updateCb = vi.fn();
    api.subscribe(progressCb);
    api.onUpdateAvailable(updateCb);
    api.dispose();

    expect(api.disposed).toBe(true);
    expect(widget.dispose).toHaveBeenCalledOnce();

    // Further progress updates are no-ops (load-phase scoped).
    api.update('sw', 50, 'ignored');
    expect(progressCb).not.toHaveBeenCalled();
    expect(widget.updateProgress).not.toHaveBeenCalled();

    // Update handlers survive dispose (app-lifetime scoped) — see api.ts.
    api.notifyUpdateAvailable();
    expect(updateCb).toHaveBeenCalledOnce();
  });

  it('dispose is idempotent', () => {
    api.dispose();
    api.dispose();
    expect(widget.dispose).toHaveBeenCalledTimes(1);
  });

  it('error() forwards message to widget.showError', () => {
    api.error('boom');
    expect(widget.showError).toHaveBeenCalledWith('boom');
  });

  describe('onUpdateAvailable', () => {
    it('fires registered handlers on notifyUpdateAvailable', () => {
      const a = vi.fn();
      const b = vi.fn();
      api.onUpdateAvailable(a);
      api.onUpdateAvailable(b);

      api.notifyUpdateAvailable();

      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
    });

    it('returns an unsubscribe function', () => {
      const handler = vi.fn();
      const unsubscribe = api.onUpdateAvailable(handler);
      unsubscribe();

      api.notifyUpdateAvailable();

      expect(handler).not.toHaveBeenCalled();
    });

    it('handlers survive dispose and still fire on subsequent notifyUpdateAvailable', () => {
      const handler = vi.fn();
      api.onUpdateAvailable(handler);
      api.dispose();

      api.notifyUpdateAvailable();

      expect(handler).toHaveBeenCalledOnce();
    });

    it('a synchronous handler that throws does not stop other handlers', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const sibling = vi.fn();
      api.onUpdateAvailable(() => {
        throw new Error('boom');
      });
      api.onUpdateAvailable(sibling);

      api.notifyUpdateAvailable();

      expect(sibling).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        '[Bootstrap] onUpdateAvailable handler threw:',
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it('routes async-handler rejections to console.error', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      api.onUpdateAvailable(async () => {
        throw new Error('async boom');
      });

      api.notifyUpdateAvailable();
      // Flush microtasks so the rejected Promise's .catch runs.
      await Promise.resolve();
      await Promise.resolve();

      expect(errorSpy).toHaveBeenCalledWith(
        '[Bootstrap] onUpdateAvailable async handler rejected:',
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  describe('updateAndLog', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it('forward-clamps percent (never regresses)', () => {
      api.updateAndLog('sw', 30, 'first');
      api.updateAndLog('sw', 10, 'tries to go back');
      expect(api.progress.percent).toBe(30);
    });

    it('clamps percent to [prev, 100]', () => {
      api.updateAndLog('sw', 150, 'over');
      expect(api.progress.percent).toBe(100);
    });

    it('no-ops after dispose', () => {
      api.dispose();
      api.updateAndLog('sw', 50, 'late');
      expect(api.progress.percent).toBe(0);
    });

    it('logs only when percent advances or message changes', () => {
      api.updateAndLog('sw', 30, 'same');
      const afterFirst = logSpy.mock.calls.length;
      api.updateAndLog('sw', 30, 'same');
      expect(logSpy.mock.calls.length).toBe(afterFirst);

      api.updateAndLog('sw', 30, 'changed');
      expect(logSpy.mock.calls.length).toBeGreaterThan(afterFirst);
    });
  });
});

describe('installGlobalAPI', () => {
  let widget: ReturnType<typeof makeWidgetStub>;
  let api: BootstrapAPI;

  beforeEach(() => {
    widget = makeWidgetStub();
    api = new BootstrapAPI(widget as unknown as LoadingWidget);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['Bootstrap'];
    delete (window as unknown as Record<string, unknown>)['updateLoadingProgress'];
    delete (window as unknown as Record<string, unknown>)['removeLoadingIndicator'];
    vi.restoreAllMocks();
  });

  it('exposes window.Bootstrap with progress/subscribe/dispose', () => {
    installGlobalAPI(api);
    const bootstrap = (window as unknown as Record<string, unknown>)[
      'Bootstrap'
    ] as {
      progress: unknown;
      subscribe: unknown;
      dispose: unknown;
    };
    expect(bootstrap).toBeDefined();
    expect(typeof bootstrap.subscribe).toBe('function');
    expect(typeof bootstrap.dispose).toBe('function');
  });

  it('window.Bootstrap.progress reads live state', () => {
    installGlobalAPI(api);
    api.update('sw', 42, 'live');
    const bootstrap = (window as unknown as Record<string, unknown>)[
      'Bootstrap'
    ] as { progress: { percent: number } };
    expect(bootstrap.progress.percent).toBe(42);
  });

  it('window.updateLoadingProgress advances the api', () => {
    installGlobalAPI(api);
    const fn = (window as unknown as Record<string, unknown>)[
      'updateLoadingProgress'
    ] as (p: number, t?: string) => void;
    fn(55, 'half-way');
    expect(api.progress.phase).toBe('dart-init');
    expect(api.progress.percent).toBe(55);
    expect(api.progress.message).toBe('half-way');
  });

  it('window.updateLoadingProgress clamps to [0, 100] and tolerates non-numbers', () => {
    installGlobalAPI(api);
    const fn = (window as unknown as Record<string, unknown>)[
      'updateLoadingProgress'
    ] as (p: unknown, t?: string) => void;
    fn(150);
    expect(api.progress.percent).toBe(100);
    // Negative clamps to 0 but forward-only lock already at 100 → stays 100.
    fn(-5);
    expect(api.progress.percent).toBe(100);
  });

  it('window.removeLoadingIndicator disposes the API', () => {
    installGlobalAPI(api);
    const fn = (window as unknown as Record<string, unknown>)[
      'removeLoadingIndicator'
    ] as () => void;
    fn();
    expect(api.disposed).toBe(true);
  });

  it('window.Bootstrap.applyUpdate activates a waiting worker', async () => {
    installGlobalAPI(api);
    const postMessage = vi.fn();
    const waiting = { postMessage };
    const getRegistration = vi.fn(async () => ({ waiting }));
    const addEventListener = vi.fn(
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === 'controllerchange') {
          setTimeout(() => {
            if (typeof listener === 'function') {
              listener(new Event('controllerchange'));
            } else {
              listener.handleEvent(new Event('controllerchange'));
            }
          }, 0);
        }
        return undefined;
      },
    );
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration,
        addEventListener,
      },
    });
    const bootstrap = (window as unknown as Record<string, unknown>)[
      'Bootstrap'
    ] as {
      applyUpdate: (reload?: boolean) => Promise<boolean>;
    };

    await expect(bootstrap.applyUpdate(false)).resolves.toBe(true);

    expect(getRegistration).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' });

    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  });
});
