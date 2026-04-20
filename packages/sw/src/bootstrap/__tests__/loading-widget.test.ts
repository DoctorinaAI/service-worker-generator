/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoadingWidget } from '../loading-widget';
import type { ResolvedConfig } from '../config';
import { STALLED_TIMEOUT_MS } from '../../shared/constants';

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

  it('dispose flips flutter-view pointerEvents to auto', () => {
    const view = document.createElement('flutter-view');
    view.style.pointerEvents = 'none';
    document.body.appendChild(view);

    const w = new LoadingWidget(uiConfig());
    w.mount();
    w.dispose();
    expect((view as HTMLElement).style.pointerEvents).toBe('auto');
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
