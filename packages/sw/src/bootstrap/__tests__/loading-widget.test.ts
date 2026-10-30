/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoadingWidget } from '../loading-widget';
import type { ResolvedConfig } from '../config';
import { RESET_TIMEOUT_MS, STALLED_TIMEOUT_MS } from '../../shared/constants';
import { FOREIGN_RELOAD_KEY } from '../sw-registration';

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
    expect(status.style.color).toBe('rgb(255, 68, 68)');
    const logo = document.querySelector('.sw-logo-container');
    expect(logo?.classList.contains('is-stalled')).toBe(true);
  });

  it('no-ops after dispose', () => {
    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.dispose();
    expect(() => w.showError('late')).not.toThrow();
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

  function clickReset(): void {
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
