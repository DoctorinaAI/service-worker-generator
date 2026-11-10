/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoadingWidget } from '../loading-widget';
import type { ResolvedConfig } from '../config';
import {
  RESET_TIMEOUT_MS,
  STALLED_TIMEOUT_MS,
  UNREPORTED_STALLED_TIMEOUT_MS,
} from '../../shared/constants';
import { FOREIGN_RELOAD_KEY } from '../sw-registration';
import { DEFAULT_STRINGS } from '../../shared/strings';
import { contrastRatio } from '../color';

function uiConfig(
  overrides: Partial<ResolvedConfig['ui']> = {},
): ResolvedConfig['ui'] {
  return {
    logo: '',
    title: '',
    theme: 'auto',
    color: '#25D366',
    showPercentage: true,
    minProgress: 0,
    maxProgress: 90,
    strings: { ...DEFAULT_STRINGS },
    ...overrides,
  };
}

function cleanup(): void {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  vi.restoreAllMocks();
}

// JSDOM doesn't provide matchMedia; stub it once so the widget can resolve theme.
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

describe('LoadingWidget mount/dispose', () => {
  afterEach(cleanup);

  it('mounts a #sw-loading root element into document.body', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    expect(document.getElementById('sw-loading')).not.toBeNull();
  });

  it('injects a <style> element into <head>', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    expect(document.head.querySelector('style')).not.toBeNull();
  });

  it('includes a <img> when config.logo is set', () => {
    const w = new LoadingWidget(uiConfig({ logo: 'logo.png' }));
    w.mount();
    const img = document.querySelector('img.sw-logo-image') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // jsdom resolves the src against the current origin.
    expect(img!.src).toContain('logo.png');
  });

  it('omits the <img> when no logo is configured', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    expect(document.querySelector('img.sw-logo-image')).toBeNull();
  });

  it('includes a <h1> when config.title is set', () => {
    const w = new LoadingWidget(uiConfig({ title: 'Hello' }));
    w.mount();
    const h1 = document.querySelector('h1.sw-title');
    expect(h1?.textContent).toBe('Hello');
  });

  it('includes the percentage element when showPercentage is true', () => {
    const w = new LoadingWidget(uiConfig({ showPercentage: true }));
    w.mount();
    expect(document.querySelector('.sw-percentage')).not.toBeNull();
  });

  it('omits the percentage element when showPercentage is false', () => {
    const w = new LoadingWidget(uiConfig({ showPercentage: false }));
    w.mount();
    expect(document.querySelector('.sw-percentage')).toBeNull();
  });

  it('dispose sets opacity to 0 and then removes the container/style on transitionend', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const container = document.getElementById('sw-loading')!;
    w.dispose();
    expect(container.style.opacity).toBe('0');

    container.dispatchEvent(new Event('transitionend'));
    expect(document.getElementById('sw-loading')).toBeNull();
    expect(document.head.querySelector('style')).toBeNull();
  });

  it('dispose is idempotent', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.dispose();
    expect(() => w.dispose()).not.toThrow();
  });

  it('dispose restores flutter-view pointerEvents to the stylesheet value', () => {
    const view = document.createElement('flutter-view');
    view.style.pointerEvents = 'none';
    document.body.appendChild(view);

    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.dispose();
    // '' rather than 'auto': the app's own CSS decides again.
    expect((view as HTMLElement).style.pointerEvents).toBe('');
  });
});

describe('LoadingWidget updateProgress', () => {
  afterEach(cleanup);

  it('updates the status text', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.updateProgress(10, 'downloading');
    const status = document.querySelector('.sw-status span:first-child');
    expect(status?.textContent).toBe('downloading');
  });

  it('updates the percentage element', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.updateProgress(37.4, 'x');
    const pct = document.querySelector('.sw-percentage');
    expect(pct?.textContent).toBe('37%');
  });

  it('clamps upward to 100 and does not overshoot', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.updateProgress(150, 'too high');
    const pct = document.querySelector('.sw-percentage');
    expect(pct?.textContent).toBe('100%');
  });

  it('only allows forward progress', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.updateProgress(60, 'a');
    w.updateProgress(30, 'b');
    const pct = document.querySelector('.sw-percentage');
    expect(pct?.textContent).toBe('60%');
  });

  it('no-ops after dispose', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.dispose();
    const container = document.getElementById('sw-loading')!;
    container.dispatchEvent(new Event('transitionend'));
    // should not throw
    w.updateProgress(80, 'after');
    expect(document.querySelector('.sw-percentage')).toBeNull();
  });

  it('adjusts strokeDashoffset on the progress ring', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.updateProgress(50, 'halfway');
    const fill = document.querySelector('.sw-progress-ring-fill') as SVGCircleElement;
    expect(fill.style.strokeDashoffset).not.toBe('');
  });
});

describe('LoadingWidget showError', () => {
  afterEach(cleanup);

  it('replaces status with the error message and activates the reload overlay', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.showError('something broke');
    const status = document.querySelector(
      '.sw-status span:first-child',
    ) as HTMLSpanElement;
    expect(status.textContent).toBe('something broke');
    // Darkened from #ff4444 until it reads on the light background: 3.3:1
    // was not enough for body text (audit #30, item 5.1).
    expect(contrastRatio(status.style.color, '#f4fdf7')).toBeGreaterThanOrEqual(
      4.5,
    );
    const logo = document.querySelector('.sw-logo-container');
    expect(logo?.classList.contains('is-stalled')).toBe(true);
  });

  it('no-ops after dispose', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.dispose();
    expect(() => w.showError('late')).not.toThrow();
  });

  it('stops looking like it is still loading', () => {
    // The ellipsis kept animating after "could not be loaded", and the
    // stall timer of the last update still fired on the error screen.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const w = new LoadingWidget(uiConfig());
      w.mount();
      w.updateProgress(40, 'loading');
      w.showError('something broke');

      expect((document.querySelector('.sw-loading-dots') as HTMLElement).hidden).toBe(true);
      vi.advanceTimersByTime(10 * 60_000);
      expect(warn).not.toHaveBeenCalledWith('[Bootstrap] Loading appears stalled');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('LoadingWidget reload button', () => {
  afterEach(cleanup);

  it('is out of reach until it is shown', () => {
    // Transparent was not enough: an invisible button took keyboard focus,
    // and Enter reloaded the page mid-download.
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const css = document.querySelector('style')!.textContent!;
    const rule = (selector: string): string => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf('}', start));
    };
    expect(rule('      .sw-reload-overlay')).toContain('visibility: hidden');
    expect(rule('.sw-logo-container.is-stalled .sw-reload-overlay')).toContain(
      'visibility: visible',
    );
  });
});

describe('LoadingWidget stall detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('shows the reload overlay after the stall timeout without further updates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    vi.advanceTimersByTime(STALLED_TIMEOUT_MS + 1);
    const logo = document.querySelector('.sw-logo-container');
    expect(logo?.classList.contains('is-stalled')).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not fire the stall warning after progress reaches 100', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.updateProgress(100, 'done');
    vi.advanceTimersByTime(STALLED_TIMEOUT_MS + 1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * Audit #30, item 1.8: nothing reports progress to a page no worker is
   * serving, so between 25% and 80% the ring sits still for the whole
   * download — and the overlay's reset would throw that download away.
   */
  it('waits longer for a load nothing is reporting on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.expectSilence();

    vi.advanceTimersByTime(STALLED_TIMEOUT_MS + 1);
    const logo = document.querySelector('.sw-logo-container');
    expect(logo?.classList.contains('is-stalled')).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    // Still a rescue, just a later one.
    vi.advanceTimersByTime(UNREPORTED_STALLED_TIMEOUT_MS);
    expect(logo?.classList.contains('is-stalled')).toBe(true);
    warn.mockRestore();
  });

  it('re-arms the timer already running when it starts expecting silence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    // Most of the short budget has passed before the pipeline knows that
    // nothing will report on this load.
    vi.advanceTimersByTime(STALLED_TIMEOUT_MS - 1_000);
    w.expectSilence();
    vi.advanceTimersByTime(2_000);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('takes the overlay back down once the load moves again', () => {
    // It used to stay up for the rest of the load: a single slow stretch
    // on a mobile link left a blurred logo and a pulsing reload button
    // over a download that was going fine.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    vi.advanceTimersByTime(STALLED_TIMEOUT_MS + 1);
    const logo = document.querySelector('.sw-logo-container');
    expect(logo?.classList.contains('is-stalled')).toBe(true);

    w.updateProgress(42, 'Loading application');
    expect(logo?.classList.contains('is-stalled')).toBe(false);

    // And it comes back if the new silence outlasts the budget too.
    vi.advanceTimersByTime(STALLED_TIMEOUT_MS + 1);
    expect(logo?.classList.contains('is-stalled')).toBe(true);
    warn.mockRestore();
  });

  it('keeps the overlay up when only the label changes', () => {
    // A stage label moving while the ring stands still is the stall.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.updateProgress(42, 'Loading application');
    vi.advanceTimersByTime(STALLED_TIMEOUT_MS + 1);
    const logo = document.querySelector('.sw-logo-container');
    expect(logo?.classList.contains('is-stalled')).toBe(true);

    w.updateProgress(42, 'Initializing Flutter engine');
    expect(logo?.classList.contains('is-stalled')).toBe(true);
    warn.mockRestore();
  });

  it('leaves the error overlay up', () => {
    // Nothing moves after a failure, and the API makes the error state
    // terminal, but the widget must not undo its own error screen.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.showError('something broke');
    w.updateProgress(99, 'Loaded 5 of 5 resources');

    const logo = document.querySelector('.sw-logo-container');
    expect(logo?.classList.contains('is-stalled')).toBe(true);
    warn.mockRestore();
  });

  it('goes back to the short budget when progress arrives after all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.expectSilence();
    w.expectProgress();

    vi.advanceTimersByTime(STALLED_TIMEOUT_MS + 1);
    expect(document.querySelector('.sw-logo-container')?.classList.contains('is-stalled')).toBe(
      true,
    );
    warn.mockRestore();
  });
});

describe('LoadingWidget reset action', () => {
  let originalLocation: Location;
  let reloadSpy: ReturnType<typeof vi.fn>;
  let baseElement: HTMLBaseElement;

  /** A registration whose `unregister()` never settles, as a wedged job queue produces. */
  function hangingRegistration(scriptURL: string): ServiceWorkerRegistration {
    return {
      active: { scriptURL },
      waiting: null,
      installing: null,
      unregister: vi.fn(() => new Promise<boolean>(() => {})),
    } as unknown as ServiceWorkerRegistration;
  }

  function settledRegistration(scriptURL: string): ServiceWorkerRegistration {
    return {
      active: { scriptURL },
      waiting: null,
      installing: null,
      unregister: vi.fn(async () => true),
    } as unknown as ServiceWorkerRegistration;
  }

  function installCaches(names: string[]): { deleted: string[] } {
    const deleted: string[] = [];
    const stub = {
      keys: async () => names,
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    } as unknown as CacheStorage;
    (globalThis as unknown as { caches: CacheStorage }).caches = stub;
    (window as unknown as { caches: CacheStorage }).caches = stub;
    return { deleted };
  }

  function installRegistrations(regs: ServiceWorkerRegistration[]): void {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations: async () => regs },
    });
  }

  /**
   * Click the overlay button as a user who has already tried a plain
   * reload: the first click only reloads now (audit #30, item 5.2), and
   * these tests are about what the reset itself does.
   */
  function clickReset(): void {
    window.sessionStorage.setItem('sw-overlay-reload-tried', '1');
    const button = document.querySelector<HTMLButtonElement>('.sw-reload-overlay');
    button?.click();
  }

  /** The first click on a fresh overlay. */
  function clickReload(): void {
    const button = document.querySelector<HTMLButtonElement>('.sw-reload-overlay');
    button?.click();
  }

  beforeEach(() => {
    // Touched before `location` is replaced below: JSDOM resolves storage
    // from the document origin on first access, and a stubbed location
    // leaves that lookup with nothing to resolve.
    window.sessionStorage.clear();
    vi.useFakeTimers();
    baseElement = document.createElement('base');
    baseElement.href = 'https://example.com/';
    document.head.appendChild(baseElement);
    originalLocation = window.location;
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: 'https://example.com/', reload: reloadSpy },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    baseElement.remove();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
    try {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    } catch {
      // ignore
    }
    window.sessionStorage.clear();
    cleanup();
  });


  /**
   * Audit #30, item 5.2: the only button on the failure screen cleared a
   * cache that was probably fine, throwing away a download the user had
   * already paid for. The failure is far more often a connection that
   * dropped.
   */
  describe('reload before reset', () => {
    it('reloads on the first click, touching nothing', async () => {
      const { deleted } = installCaches(['app-cache-v1']);
      installRegistrations([settledRegistration('https://example.com/sw.js?v=1')]);
      const w = new LoadingWidget(uiConfig(), 'sw.js');
      w.mount();
      w.showError('something broke');

      clickReload();
      await vi.advanceTimersByTimeAsync(RESET_TIMEOUT_MS + 1);

      expect(reloadSpy).toHaveBeenCalledOnce();
      expect(deleted).toEqual([]);
    });

    it('clears the caching layer on the click after that', async () => {
      const { deleted } = installCaches(['app-cache-v1']);
      installRegistrations([settledRegistration('https://example.com/sw.js?v=1')]);
      const first = new LoadingWidget(uiConfig(), 'sw.js');
      first.mount();
      first.showError('something broke');
      clickReload();
      cleanup();

      // The reload happened and the page came back still broken.
      const second = new LoadingWidget(uiConfig(), 'sw.js');
      second.mount();
      second.showError('something broke');
      clickReload();
      await vi.advanceTimersByTimeAsync(RESET_TIMEOUT_MS + 1);

      expect(deleted).toEqual(['app-cache-v1']);
    });

    it('names the button for what the next click does', () => {
      installCaches([]);
      const w = new LoadingWidget(uiConfig(), 'sw.js');
      w.mount();
      w.showError('something broke');
      const button = document.querySelector('.sw-reload-overlay');
      expect(button?.getAttribute('aria-label')).toBe(DEFAULT_STRINGS.reload);

      window.sessionStorage.setItem('sw-overlay-reload-tried', '1');
      w.showError('again');
      expect(button?.getAttribute('aria-label')).toBe(DEFAULT_STRINGS.reset);
    });

    it('resets on the first click when sessionStorage is blocked', async () => {
      // Without somewhere to remember the reload, the button does the
      // thing that helps if anything does.
      const { deleted } = installCaches(['app-cache-v1']);
      installRegistrations([settledRegistration('https://example.com/sw.js?v=1')]);
      const saved = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
      try {
        const w = new LoadingWidget(uiConfig(), 'sw.js');
        w.mount();
        w.showError('something broke');

        clickReload();
        await vi.advanceTimersByTimeAsync(RESET_TIMEOUT_MS + 1);

        expect(deleted).toEqual(['app-cache-v1']);
      } finally {
        if (saved) Object.defineProperty(window, 'sessionStorage', saved);
      }
    });

    it('says it is offline instead of showing the error', () => {
      installCaches([]);
      const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const w = new LoadingWidget(uiConfig(), 'sw.js');
      w.mount();
      w.showError('WebAssembly.instantiate(): Import #3');

      const status = document.querySelector(
        '.sw-status span:first-child',
      ) as HTMLSpanElement;
      expect(status.textContent).toBe(DEFAULT_STRINGS.offline);
      online.mockRestore();
    });

    it('uses the page’s own wording', () => {
      installCaches([]);
      const w = new LoadingWidget(
        uiConfig({
          strings: { ...DEFAULT_STRINGS, reload: 'Обновить', offline: 'Нет сети' },
        }),
        'sw.js',
      );
      w.mount();
      const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      w.showError('whatever');

      expect(
        document.querySelector('.sw-reload-overlay')?.getAttribute('aria-label'),
      ).toBe('Обновить');
      expect(
        document.querySelector('.sw-status span:first-child')?.textContent,
      ).toBe('Нет сети');
      online.mockRestore();
    });

    // The label the user reads before the pipeline's first stage update,
    // and the only one they get from a pipeline that throws before it.
    // It used to be the literal `Initializing`, which an app in another
    // language could not replace — the very thing the string table exists
    // to fix (audit #30, item 5.1).
    it('takes even the pre-pipeline status from the string table', () => {
      const w = new LoadingWidget(
        uiConfig({ strings: { ...DEFAULT_STRINGS, starting: 'Запуск' } }),
      );
      w.mount();

      expect(
        document.querySelector('.sw-status span:first-child')?.textContent,
      ).toBe('Запуск');
    });

    it('falls back to the default wording for that status', () => {
      const w = new LoadingWidget(uiConfig());
      w.mount();

      expect(
        document.querySelector('.sw-status span:first-child')?.textContent,
      ).toBe(DEFAULT_STRINGS.starting);
    });
  });

  it('reloads even when unregister() never settles', async () => {
    // The wedge this button rescues is the one that makes `unregister()`
    // hang — so waiting on it without a deadline strands the user on the
    // stalled screen they clicked it to leave.
    installCaches(['app-cache-v1']);
    installRegistrations([hangingRegistration('https://example.com/sw.js?v=1')]);
    const w = new LoadingWidget(uiConfig(), 'sw.js');
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(RESET_TIMEOUT_MS + 1);

    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('clears caches and unregisters our own worker on the happy path', async () => {
    const { deleted } = installCaches(['app-cache-v1', 'app-cache-manifest']);
    const ours = settledRegistration('https://example.com/sw.js?v=1');
    installRegistrations([ours]);
    const w = new LoadingWidget(uiConfig(), 'sw.js');
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(deleted).toEqual(['app-cache-v1', 'app-cache-manifest']);
    expect(ours.unregister).toHaveBeenCalledOnce();
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('leaves unrelated registrations like firebase-messaging-sw.js alone', async () => {
    // Unregistering a push worker silently drops its subscription — an
    // outcome that has nothing to do with a stuck cache.
    installCaches([]);
    const ours = settledRegistration('https://example.com/sw.js?v=1');
    const push = settledRegistration('https://example.com/firebase-messaging-sw.js');
    installRegistrations([ours, push]);
    const w = new LoadingWidget(uiConfig(), 'sw.js');
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(ours.unregister).toHaveBeenCalledOnce();
    expect(push.unregister).not.toHaveBeenCalled();
  });

  it('preserves application storage', async () => {
    // On Flutter web `shared_preferences` is localStorage: clearing it signs
    // the user out and drops local app state, which is not what a reload
    // button should do. Asserted against a stub because this JSDOM runs
    // without a localStorage implementation at all.
    const clear = vi.fn();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { clear, getItem: () => null, setItem: () => undefined },
    });
    installCaches([]);
    installRegistrations([settledRegistration('https://example.com/sw.js?v=1')]);
    window.sessionStorage.setItem('unrelated', 'kept');
    const w = new LoadingWidget(uiConfig(), 'sw.js');
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(clear).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('unrelated')).toBe('kept');
  });

  it('re-arms the one-shot foreign-controller recovery', async () => {
    installCaches([]);
    installRegistrations([settledRegistration('https://example.com/sw.js?v=1')]);
    window.sessionStorage.setItem(FOREIGN_RELOAD_KEY, '1');
    const w = new LoadingWidget(uiConfig(), 'sw.js');
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(window.sessionStorage.getItem(FOREIGN_RELOAD_KEY)).toBeNull();
  });
  it('unregisters every registration when constructed without a filename', async () => {
    installCaches([]);
    const a = settledRegistration('https://example.com/sw.js?v=1');
    const b = settledRegistration('https://example.com/other-sw.js');
    installRegistrations([a, b]);
    const w = new LoadingWidget(uiConfig());
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(a.unregister).toHaveBeenCalledOnce();
    expect(b.unregister).toHaveBeenCalledOnce();
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('recognises our worker while it is still installing or waiting', async () => {
    // A reset during a wedged install: the registration has no active
    // worker yet, and it is exactly the one to drop.
    installCaches([]);
    const installing = {
      active: null,
      waiting: null,
      installing: { scriptURL: 'https://example.com/sw.js?v=2' },
      unregister: vi.fn(async () => true),
    } as unknown as ServiceWorkerRegistration;
    const empty = {
      active: null,
      waiting: null,
      installing: null,
      unregister: vi.fn(async () => true),
    } as unknown as ServiceWorkerRegistration;
    installRegistrations([installing, empty]);
    const w = new LoadingWidget(uiConfig(), 'sw.js');
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(installing.unregister).toHaveBeenCalledOnce();
    expect(empty.unregister).not.toHaveBeenCalled();
  });

  it('deletes only caches under this build\'s prefix when one is known', async () => {
    const { deleted } = installCaches([
      'my-app-v1',
      'my-app-temp-v2',
      'my-app-manifest',
      'my-app2-v1',
      'workbox-precache-v2',
      'firebase-cache',
      'my-app',
    ]);
    installRegistrations([]);
    const w = new LoadingWidget(uiConfig(), 'sw.js', 'my-app');
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(deleted).toEqual(['my-app-v1', 'my-app-temp-v2', 'my-app-manifest']);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('spares the caches of an app whose prefix extends ours', async () => {
    // `my-app-admin` names its caches `my-app-…`; its manifest cache marks
    // the prefix as in use, as it does for the worker's own cleanup.
    const { deleted } = installCaches([
      'my-app-v1',
      'my-app-manifest',
      'my-app-admin-manifest',
      'my-app-admin-v3',
      'my-app-admin-temp-v4',
    ]);
    installRegistrations([]);
    const w = new LoadingWidget(uiConfig(), 'sw.js', 'my-app');
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(deleted).toEqual(['my-app-v1', 'my-app-manifest']);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('deletes every cache when no prefix is known (older generated bootstrap)', async () => {
    const { deleted } = installCaches(['my-app-v1', 'workbox-precache-v2']);
    installRegistrations([]);
    const w = new LoadingWidget(uiConfig(), 'sw.js', undefined);
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(deleted).toEqual(['my-app-v1', 'workbox-precache-v2']);
  });

  it('treats an empty or non-string prefix as unknown', async () => {
    const { deleted } = installCaches(['a-v1', 'b']);
    installRegistrations([]);
    const w = new LoadingWidget(uiConfig(), 'sw.js', '' as string);
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(deleted).toEqual(['a-v1', 'b']);
  });

  it('spares a registration whose script URL it cannot parse, and still reloads', async () => {
    installCaches([]);
    const odd = settledRegistration('not a url');
    installRegistrations([odd]);
    const w = new LoadingWidget(uiConfig(), 'sw.js');
    w.mount();

    clickReset();
    await vi.advanceTimersByTimeAsync(1);

    expect(odd.unregister).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledOnce();
  });
});

describe('LoadingWidget resilience under strict pages', () => {
  afterEach(cleanup);

  it('builds the reload icon without innerHTML (Trusted Types)', () => {
    const setter = vi.fn();
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true,
      get: desc.get,
      set(this: Element, v: string) {
        setter(v);
        throw new TypeError('This document requires TrustedHTML assignment');
      },
    });
    try {
      const w = new LoadingWidget(uiConfig());
      expect(() => w.mount()).not.toThrow();
    } finally {
      Object.defineProperty(Element.prototype, 'innerHTML', desc);
    }
    expect(setter).not.toHaveBeenCalled();
    const svg = document.querySelector('.sw-reload-overlay svg');
    expect(svg).not.toBeNull();
    expect(svg!.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(svg!.querySelectorAll('path')).toHaveLength(4);
  });

  it('copies the bootstrap script nonce to the injected style', () => {
    const script = document.createElement('script');
    script.setAttribute('data-sw-bootstrap', '');
    script.setAttribute('nonce', 'abc123');
    document.head.appendChild(script);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const style = document.head.querySelector('style')!;
    expect(style.getAttribute('nonce') ?? (style as HTMLStyleElement & { nonce?: string }).nonce).toBe(
      'abc123',
    );
  });

  it('reads the nonce from the property when the attribute is hidden', () => {
    // Browsers blank the nonce attribute after load; the IDL property keeps it.
    const script = document.createElement('script');
    script.setAttribute('data-sw-bootstrap', '');
    Object.defineProperty(script, 'nonce', { value: 'hidden-n', configurable: true });
    document.head.appendChild(script);
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const style = document.head.querySelector('style')!;
    expect(style.getAttribute('nonce')).toBe('hidden-n');
  });

  it('adds no nonce when the script has none', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    expect(document.head.querySelector('style')!.hasAttribute('nonce')).toBe(false);
  });

  it('removes what it added when the mount fails part-way', () => {
    const w = new LoadingWidget(uiConfig());
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => w.mount()).toThrow('boom');
    expect(document.head.querySelector('style')).toBeNull();
    // Later calls stay harmless.
    expect(() => w.updateProgress(10, 'x')).not.toThrow();
    expect(() => w.showError('e')).not.toThrow();
    expect(() => w.dispose()).not.toThrow();
  });
});

describe('LoadingWidget accessibility', () => {
  afterEach(cleanup);

  it('exposes the ring as a progressbar with a 0..100 range', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const bar = document.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute('aria-valuemin')).toBe('0');
    expect(bar!.getAttribute('aria-valuemax')).toBe('100');
    expect(bar!.getAttribute('aria-valuenow')).toBe('0');
    w.updateProgress(42.6, 'x');
    expect(bar!.getAttribute('aria-valuenow')).toBe('43');
  });

  it('announces status politely, and assertively on error', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const status = document.querySelector('.sw-status')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    w.showError('failed');
    expect(status.getAttribute('role')).toBe('alert');
    expect(status.getAttribute('aria-live')).toBe('assertive');
  });

  it('leaves the live status alone when the message has not changed', () => {
    // Rewriting the same text is a DOM change a screen reader may announce
    // again; progress updates repeat the message many times per stage.
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const status = document.querySelector('.sw-status')!;
    w.updateProgress(10, 'Loading application');
    const node = status.firstElementChild!.firstChild;
    w.updateProgress(20, 'Loading application');
    expect(status.firstElementChild!.firstChild).toBe(node);
    w.updateProgress(30, 'Starting application');
    expect(status.firstElementChild!.textContent).toBe('Starting application');
  });

  it('turns off the fade-in, dots and ring transition under reduced motion', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const css = document.head.querySelector('style')!.textContent!;
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/#sw-loading\s*\{[^}]*animation:\s*none/);
    expect(block).toMatch(/\.sw-loading-dots::after\s*\{[^}]*animation:\s*none/);
    expect(block).toMatch(/\.sw-progress-ring-fill\s*\{[^}]*transition:\s*none/);
  });

  it('lets long status text wrap on narrow screens', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const css = document.head.querySelector('style')!.textContent!;
    const rule = css.slice(css.indexOf('.sw-status {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toMatch(/max-width:/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  // jsdom does not lay out, so these pin the declarations the layout rests
  // on. Each one failing is a glitch that reached a release.
  it('keeps the animated dots on a single line', () => {
    // `.sw-status` sets `overflow-wrap: anywhere` and the dots box is only
    // ~1.5em wide, so without this the three dots wrap onto three lines,
    // the box grows three lines tall and `vertical-align: bottom` hangs the
    // extra ones above the message.
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const css = document.head.querySelector('style')!.textContent!;
    const rule = css.slice(css.indexOf('.sw-loading-dots::after {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toMatch(/white-space:\s*(pre|nowrap)/);
  });

  it('animates the dots without changing their footprint', () => {
    // A width sweep moves the dots onto a line of their own and back on a
    // line the message nearly fills, shifting everything below them.
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const css = document.head.querySelector('style')!.textContent!;
    const frames = css.slice(css.indexOf('@keyframes sw-dots'));
    const body = frames.slice(0, frames.indexOf('\n      }'));
    expect(body).toMatch(/clip-path:/);
    expect(body).not.toMatch(/\bwidth:/);
  });

  it('keeps a long title inside the viewport', () => {
    const w = new LoadingWidget(uiConfig({ title: 'x' }));
    w.mount();
    const css = document.head.querySelector('style')!.textContent!;
    const rule = css.slice(css.indexOf('.sw-title {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toMatch(/max-width:/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('pads the root and lets it scroll rather than clip', () => {
    // A long message on a phone in landscape overflows a centred column;
    // `safe` keeps the overflow below the top edge, where it is reachable.
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const css = document.head.querySelector('style')!.textContent!;
    const rule = css.slice(css.indexOf('#sw-loading {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toMatch(/padding:/);
    expect(body).toMatch(/box-sizing:\s*border-box/);
    expect(body).toMatch(/justify-content:\s*safe\s+center/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  it('lets the progress ring glow past the ring', () => {
    // The arc carries a drop-shadow glow, and an outer <svg> clips to its
    // viewport unless told otherwise — the glow was cut off in a straight
    // line beside and above the ring.
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const css = document.head.querySelector('style')!.textContent!;
    const rule = css.slice(css.indexOf('.sw-progress-ring {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toMatch(/overflow:\s*visible/);
    const fill = css.slice(css.indexOf('.sw-progress-ring-fill {'));
    expect(fill.slice(0, fill.indexOf('}'))).toMatch(/drop-shadow/);
  });

  it('compacts the layout on a short viewport', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    const css = document.head.querySelector('style')!.textContent!;
    expect(css).toMatch(/@media\s*\(max-height:\s*480px\)/);
    // After the width query, so a short and narrow viewport gets both.
    expect(css.indexOf('@media (max-height: 480px)')).toBeGreaterThan(
      css.indexOf('@media (max-width: 480px)'),
    );
  });
});

describe('LoadingWidget dispose teardown', () => {
  afterEach(cleanup);

  it('ignores transitionend bubbling from child transitions', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.dispose();
    const ring = document.querySelector('.sw-progress-ring-fill')!;
    ring.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(document.getElementById('sw-loading')).not.toBeNull();
    // The container's own transition still tears it down.
    document.getElementById('sw-loading')!.dispatchEvent(new Event('transitionend'));
    expect(document.getElementById('sw-loading')).toBeNull();
  });

  it('still tears down on the safety timeout', () => {
    vi.useFakeTimers();
    try {
      const w = new LoadingWidget(uiConfig());
      w.mount();
      w.dispose();
      vi.advanceTimersByTime(700);
      expect(document.getElementById('sw-loading')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
