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

  it('dispose marks disposed, disposes widget, clears subscribers', () => {
    const cb = vi.fn();
    api.subscribe(cb);
    api.dispose();

    expect(api.disposed).toBe(true);
    expect(widget.dispose).toHaveBeenCalledOnce();

    // Further updates are no-ops
    api.update('sw', 50, 'ignored');
    expect(cb).not.toHaveBeenCalled();
    expect(widget.updateProgress).not.toHaveBeenCalled();
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
});
