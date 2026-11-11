import type { ResolvedConfig } from './config';
import { findBootstrapScript, withAlpha } from './config';
import {
  RESET_TIMEOUT_MS,
  STALLED_TIMEOUT_MS,
  UNREPORTED_STALLED_TIMEOUT_MS,
} from '../shared/constants';
import { withTimeout } from '../shared/utils';
import { ownCacheNames } from '../shared/cache-ownership';
import { FOREIGN_RELOAD_KEY } from './sw-registration';
import { log } from '../shared/logger';
import { DEFAULT_STRINGS, type StringKey } from '../shared/strings';
import { ensureContrast } from './color';

/**
 * sessionStorage key marking that the overlay's plain reload has been
 * tried in this tab, so the next click clears the caching layer instead.
 */
const RELOAD_TRIED_KEY = 'sw-overlay-reload-tried';

/** The error red, before it is checked against the background. */
const ERROR_COLOR = '#ff4444';

/**
 * Loading widget with a linear progress bar, status text, and stall
 * detection.
 */
export class LoadingWidget {
  private container: HTMLDivElement | null = null;
  private logoContainer: HTMLDivElement | null = null;
  /** The logo as mounted; replaced by a still frame once the load fails. */
  private logoImage: HTMLImageElement | null = null;
  private statusText: HTMLSpanElement | null = null;
  private statusContainer: HTMLDivElement | null = null;
  private errorTitle: HTMLParagraphElement | null = null;
  /** The progress track, which carries the progressbar role. */
  private progressBar: HTMLDivElement | null = null;
  /** The filled part of the track, whose width is the percentage. */
  private progressFill: HTMLDivElement | null = null;
  private percentageText: HTMLDivElement | null = null;
  private reloadButton: HTMLButtonElement | null = null;
  private styleElement: HTMLStyleElement | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** How much silence counts as a stall; see `expectSilence`. */
  private stallBudgetMs: number = STALLED_TIMEOUT_MS;
  private currentPercent = 0;
  private disposed = false;
  /**
   * Set by [showError]. A failure is the end of this load, so nothing
   * that arrives afterwards may undo the error screen.
   */
  private errored = false;
  /** The animated ellipsis after the status line; gone on the error screen. */
  private dots: HTMLElement | null = null;

  /**
   * @param config - Widget appearance and progress range.
   * @param swFilename - The service worker this bootstrap registers, used to
   *   keep the reset action away from unrelated registrations. Omitted by
   *   callers that only render the widget.
   * @param cachePrefix - The cache name prefix of this build's worker. When
   *   set, the reset deletes only caches named `${cachePrefix}-…`; when
   *   absent (a bootstrap generated before the prefix was injected) it
   *   deletes every cache on the origin, as it always did.
   */
  constructor(
    private config: ResolvedConfig['ui'],
    private swFilename?: string,
    private cachePrefix?: string,
  ) {}

  /**
   * Create and mount the loading widget into the DOM.
   *
   * On failure, whatever was added is removed again before the error is
   * rethrown: a lone stylesheet would still paint the page background, and
   * the caller continues loading the app without the widget.
   */
  mount(): void {
    try {
      this.injectStyles();
      this.container = this.createDOM();
      document.body.appendChild(this.container);
      this.resetStallTimer();
    } catch (error) {
      this.clearStallTimer();
      this.container?.remove();
      this.styleElement?.remove();
      this.container = null;
      this.styleElement = null;
      this.logoContainer = null;
      this.logoImage = null;
      this.progressBar = null;
      this.progressFill = null;
      this.statusText = null;
      this.statusContainer = null;
      this.errorTitle = null;
      this.percentageText = null;
      this.reloadButton = null;
      throw error;
    }
  }

  /** What the screen calls [key], with the page's overrides applied. */
  private text(key: StringKey): string {
    return this.config.strings?.[key] ?? DEFAULT_STRINGS[key];
  }

  /**
   * The background the widget paints, which every contrast check is
   * against. Read through `matchMedia` for the `auto` theme, as the
   * stylesheet does.
   */
  private get background(): string {
    const dark =
      this.config.theme === 'dark' ||
      (this.config.theme === 'auto' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    return dark ? '#1a1a2e' : '#f4fdf7';
  }

  /** The error red, readable on whichever background is in use. */
  private get errorColor(): string {
    return ensureContrast(ERROR_COLOR, this.background);
  }

  /**
   * Update the progress display.
   */
  updateProgress(percent: number, message: string): void {
    if (this.disposed) return;

    // Only allow forward progress
    const before = this.currentPercent;
    this.currentPercent = Math.max(this.currentPercent, Math.min(percent, 100));
    // The load is moving again, so the stalled overlay is a lie: it used
    // to stay up — blurred logo, pulsing reload button — for the rest of
    // the load once a single slow stretch had raised it.
    if (this.currentPercent > before) this.hideAction();

    if (this.progressFill) {
      this.progressFill.style.width = `${this.currentPercent}%`;
    }

    this.progressBar?.setAttribute(
      'aria-valuenow',
      String(Math.round(this.currentPercent)),
    );

    // The status is a live region: rewriting the same text is a change a
    // screen reader may announce again.
    if (this.statusText && this.statusText.textContent !== message) {
      this.statusText.textContent = message;
    }

    if (this.percentageText && this.config.showPercentage) {
      this.percentageText.textContent = `${Math.round(this.currentPercent)}%`;
    }

    this.resetStallTimer();
  }

  /**
   * Show a failure.
   *
   * [error] is what the user reads, so the caller is expected to have
   * chosen it; the raw reason belongs in the console and in
   * `Bootstrap.progress.detail`. When the browser says it is offline, that
   * is said instead: no reload of any kind will help until it is back, and
   * "check your connection" is the only useful instruction on that screen.
   */
  showError(error: string): void {
    if (this.disposed || !this.statusText) return;
    const offline = navigator.onLine === false;
    this.statusText.textContent = offline ? this.text('offline') : error;
    this.statusContainer?.setAttribute('role', 'alert');
    this.statusContainer?.setAttribute('aria-live', 'assertive');
    this.errored = true;
    // Nothing is loading any more: no ellipsis that says otherwise, and no
    // stall timer to report a stall on a screen that reported a failure.
    this.clearStallTimer();
    if (this.dots) this.dots.hidden = true;
    // The headline, the error colour, the hidden progress bar and the
    // button are all one class on the root: the error screen is a state
    // of this widget, not a second widget built on top of it.
    this.container?.classList.add('is-error');
    if (this.errorTitle) this.errorTitle.hidden = false;
    this.freezeLogo();
    this.showAction();
  }

  /**
   * Stop the artwork on the frame it is showing, and grey it out.
   *
   * The logo may be an animated GIF, APNG or SVG, and none of those can be
   * paused from the page: the element is an image, not a player. Drawing
   * it into a canvas captures whatever frame is on screen, and that canvas
   * replaces it — a still, which is what the error screen is. The greying
   * is a class, applied first, because it is the part that works even when
   * the capture cannot: a logo that has not finished loading, a browser
   * with no 2D context, a canvas that throws. The worst case is a logo
   * that keeps animating, in grey.
   */
  private freezeLogo(): void {
    this.logoContainer?.classList.add('is-frozen');
    const img = this.logoImage;
    if (!img) return;
    if (!img.complete || img.naturalWidth === 0) {
      // Nothing to capture yet. A failure this early is the usual case —
      // the engine can fail before the logo's own request has come back —
      // so the capture waits for the frame rather than giving up on it.
      img.addEventListener('load', () => this.freezeLogo(), { once: true });
      return;
    }
    try {
      const rect = img.getBoundingClientRect();
      const width = Math.round(rect.width) || img.naturalWidth;
      const height = Math.round(rect.height) || img.naturalHeight;
      // Capped: a device reporting 4 would quadruple the memory behind a
      // still that nobody inspects closely.
      const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      canvas.className = 'sw-logo-image';
      canvas.setAttribute('aria-hidden', 'true');
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.replaceWith(canvas);
      this.logoImage = null;
    } catch (e) {
      log.warn('[Bootstrap] Could not freeze the logo:', e);
    }
  }

  /**
   * The reload button, clicked.
   *
   * A plain reload first: the failure that put the overlay there is far
   * more often a connection that dropped or a request that timed out than
   * a cache gone bad, and clearing the cache throws away a download the
   * user already paid for. Only a second click — a reload that did not
   * help — drops the caching layer. The flag lives in `sessionStorage`, so
   * "second click" survives the reload in between, and `dispose` clears it
   * once a load succeeds.
   */
  private async onReloadClick(): Promise<void> {
    if (this.reloadButton) {
      this.reloadButton.classList.add('is-loading');
      this.reloadButton.setAttribute('disabled', 'true');
    }
    if (!this.reloadWasTried()) {
      this.rememberReloadTried();
      window.location.reload();
      return;
    }
    await this.resetCache();
  }

  /** Whether a plain reload from this overlay has already been tried. */
  private reloadWasTried(): boolean {
    try {
      return sessionStorage.getItem(RELOAD_TRIED_KEY) !== null;
    } catch {
      // Blocked storage: there is no way to tell, so the button does the
      // thing that always helps if anything does.
      return true;
    }
  }

  private rememberReloadTried(): void {
    try {
      sessionStorage.setItem(RELOAD_TRIED_KEY, '1');
    } catch {
      // Nothing to remember it in; the next click resets, as above.
    }
  }

  private forgetReloadTried(): void {
    try {
      sessionStorage.removeItem(RELOAD_TRIED_KEY);
    } catch {
      // It could not have been set either.
    }
  }

  /** Name the button for what the next click will do. */
  private labelReloadButton(): void {
    if (!this.reloadButton) return;
    const label = this.reloadWasTried()
      ? this.text('reset')
      : this.text('reload');
    this.reloadButton.textContent = label;
    this.reloadButton.setAttribute('aria-label', label);
    this.reloadButton.title = label;
  }

  /**
   * Remove the loading widget with a fade-out animation.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearStallTimer();
    // This load worked, so the next overlay — whenever it appears — starts
    // over with a plain reload rather than clearing a cache that has just
    // proved itself.
    this.forgetReloadTried();

    if (this.container) {
      this.container.style.opacity = '0';
      this.container.style.transition = 'opacity 0.4s ease-out';

      // Tear down once — either on the real transitionend, or via a
      // safety timeout if the browser skips the animation (reduced-motion,
      // background tab, discarded paint). Without the fallback the widget
      // + its stylesheet can leak indefinitely.
      //
      // `transitionend` bubbles: the ring and artwork transitions of the
      // children would otherwise end the fade before it ran. Only the
      // container's own transition counts.
      const container = this.container;
      let torn = false;
      const teardown = (): void => {
        if (torn) return;
        torn = true;
        container.removeEventListener('transitionend', onTransitionEnd);
        this.container?.remove();
        this.styleElement?.remove();
        this.container = null;
        this.styleElement = null;
        this.logoImage = null;
        this.progressFill = null;
      };
      const onTransitionEnd = (event: Event): void => {
        if (event.target === container) teardown();
      };
      container.addEventListener('transitionend', onTransitionEnd);
      setTimeout(teardown, 600);
    }

    // Re-enable pointer events on the Flutter view. '' rather than 'auto'
    // drops only the inline override the loader set, so the app's own CSS
    // decides again.
    const flutterView = document.querySelector('flutter-view') as HTMLElement;
    if (flutterView) {
      flutterView.style.pointerEvents = '';
    }
  }

  private injectStyles(): void {
    this.styleElement = document.createElement('style');
    // Under a `style-src` with a nonce and without 'unsafe-inline', the
    // stylesheet only applies when it carries the page's nonce. Browsers
    // hide the attribute after load, so the IDL property is read first.
    const script = findBootstrapScript();
    const nonce = script?.nonce || script?.getAttribute('nonce') || '';
    if (nonce) {
      this.styleElement.nonce = nonce;
      this.styleElement.setAttribute('nonce', nonce);
    }
    this.styleElement.textContent = this.getCSS();
    document.head.appendChild(this.styleElement);
  }

  private createDOM(): HTMLDivElement {
    const container = document.createElement('div');
    container.id = 'sw-loading';

    // Logo. Decorative: the title below says the same thing in words, and
    // on the error screen the headline does.
    const logoContainer = document.createElement('div');
    logoContainer.className = 'sw-logo-container';
    this.logoContainer = logoContainer;
    if (this.config.logo) {
      const img = document.createElement('img');
      img.src = this.config.logo;
      img.className = 'sw-logo-image';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      this.logoImage = img;
      logoContainer.appendChild(img);
    }
    container.appendChild(logoContainer);

    // Title
    if (this.config.title) {
      const title = document.createElement('h1');
      title.className = 'sw-title';
      title.textContent = this.config.title;
      container.appendChild(title);
    }

    // The message block: the failure headline, hidden until there is one,
    // and the status line under it. See the stylesheet for why the two
    // share a box of a fixed minimum height.
    const message = document.createElement('div');
    message.className = 'sw-message';

    const errorTitle = document.createElement('p');
    errorTitle.className = 'sw-error-title';
    errorTitle.textContent = this.text('errorTitle');
    errorTitle.hidden = true;
    this.errorTitle = errorTitle;
    message.appendChild(errorTitle);

    const statusContainer = document.createElement('div');
    statusContainer.className = 'sw-status';
    statusContainer.setAttribute('aria-live', 'polite');
    this.statusContainer = statusContainer;
    this.statusText = document.createElement('span');
    // From the string table, not a literal: this is the label the user
    // reads until the pipeline's first stage update lands, and on a
    // pipeline that throws before that it is the only label they get.
    this.statusText.textContent = this.text('starting');
    const dots = document.createElement('span');
    dots.className = 'sw-loading-dots';
    dots.setAttribute('aria-hidden', 'true');
    this.dots = dots;
    statusContainer.appendChild(this.statusText);
    statusContainer.appendChild(dots);
    message.appendChild(statusContainer);
    container.appendChild(message);

    // Progress track. The role lives here rather than on the artwork: this
    // is the element whose length is the progress.
    const progress = document.createElement('div');
    progress.className = 'sw-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', 'Loading');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    progress.setAttribute('aria-valuenow', '0');
    const fill = document.createElement('div');
    fill.className = 'sw-progress-fill';
    progress.appendChild(fill);
    this.progressBar = progress;
    this.progressFill = fill;
    container.appendChild(progress);

    // Percentage
    if (this.config.showPercentage) {
      this.percentageText = document.createElement('div');
      this.percentageText.className = 'sw-percentage';
      this.percentageText.textContent = '0%';
      container.appendChild(this.percentageText);
    }

    // The action, hidden until the load stalls or fails.
    const actions = document.createElement('div');
    actions.className = 'sw-actions';
    this.reloadButton = document.createElement('button');
    this.reloadButton.className = 'sw-action';
    this.reloadButton.type = 'button';
    this.labelReloadButton();
    this.reloadButton.addEventListener('click', () => void this.onReloadClick());
    actions.appendChild(this.reloadButton);
    container.appendChild(actions);

    return container;
  }

  /** Offer the action: the load has stalled, or it has failed. */
  private showAction(): void {
    this.container?.classList.add('is-stalled');
    this.labelReloadButton();
  }

  /**
   * Take the offer back down.
   *
   * Only progress does this, never a message: a stage label changing while
   * the bar stands still is exactly the stall being reported. The error
   * screen raises it again and nothing moves after that, so this cannot
   * hide a failure.
   */
  private hideAction(): void {
    if (this.errored) return;
    this.container?.classList.remove('is-stalled');
  }

  private resetStallTimer(): void {
    this.clearStallTimer();
    if (!this.disposed && this.currentPercent < 100) {
      this.stallTimer = setTimeout(() => {
        log.warn('[Bootstrap] Loading appears stalled');
        this.showAction();
      }, this.stallBudgetMs);
    }
  }

  /**
   * Stop treating silence as a stall for [UNREPORTED_STALLED_TIMEOUT_MS]
   * instead of [STALLED_TIMEOUT_MS].
   *
   * The pipeline calls this when no worker is reporting to this page, so
   * the only thing between 25% and 80% is a download nobody narrates. See
   * `UNREPORTED_STALLED_TIMEOUT_MS`.
   */
  expectSilence(): void {
    if (this.stallBudgetMs === UNREPORTED_STALLED_TIMEOUT_MS) return;
    this.stallBudgetMs = UNREPORTED_STALLED_TIMEOUT_MS;
    // Re-arm: the timer already running was set for the short budget.
    if (this.stallTimer) this.resetStallTimer();
  }

  /** Back to the normal threshold: something is reporting progress again. */
  expectProgress(): void {
    if (this.stallBudgetMs === STALLED_TIMEOUT_MS) return;
    this.stallBudgetMs = STALLED_TIMEOUT_MS;
    if (this.stallTimer) this.resetStallTimer();
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /**
   * Drop the caching layer and reload.
   *
   * Bounded, because the state this button exists to escape is exactly the
   * state that makes the cleanup hang: a service worker install that never
   * settles blocks its scope's job queue, and `unregister()` then waits on
   * that queue forever. Waiting on cleanup without a deadline would strand
   * the user on the stalled screen they clicked the button to leave, so
   * whatever lands within the budget is kept and the reload is
   * unconditional. `caches.delete()` does not go through that queue and
   * keeps working regardless.
   */
  private async resetCache(): Promise<void> {
    await withTimeout(this.clearCachingLayer(), RESET_TIMEOUT_MS, undefined);
    // The reload that follows is the one chance for a clean start, so the
    // flag goes: if it fails again, the next overlay starts over with a
    // plain reload rather than wiping a cache it just filled.
    this.forgetReloadTried();
    window.location.reload();
  }

  /**
   * Remove the caches and the service worker registration this bootstrap
   * owns.
   *
   * Deliberately narrower than "clear everything". Application storage is
   * left alone: on Flutter web `shared_preferences` is `localStorage`, so
   * clearing it signs the user out and discards local app state — an
   * outcome nobody expects from a reload button, and one that has nothing
   * to do with a stuck cache. Foreign registrations are left alone for the
   * same reason `reloadIfForeignController` spares them: unregistering
   * something like `firebase-messaging-sw.js` silently drops its push
   * subscription.
   */
  private async clearCachingLayer(): Promise<void> {
    try {
      if ('caches' in window) {
        const names = await caches.keys();
        const prefix =
          typeof this.cachePrefix === 'string' && this.cachePrefix
            ? this.cachePrefix
            : null;
        // With this build's prefix, other apps, Workbox or Firebase on the
        // same origin keep their caches — including an app whose prefix
        // extends ours, by the same rule the worker cleans up with. Without
        // one (a bootstrap generated before it was injected) there is no
        // way to tell, so every cache goes, as before.
        const doomed = prefix ? ownCacheNames(prefix, names) : names;
        await Promise.all(doomed.map((n) => caches.delete(n)));
        log.info(
          `[Bootstrap] Reset: deleted ${doomed.length} cache(s), kept ` +
            `${names.length - doomed.length}` +
            (prefix ? ` (prefix "${prefix}")` : ' (no prefix known, deleted all)'),
        );
      }

      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          regs.filter((reg) => this.isOwnRegistration(reg)).map((reg) => reg.unregister()),
        );
      }

      // Re-arm the one-shot foreign-controller recovery, so the reload this
      // reset is about to trigger can use it if a stale controller is what
      // wedged us in the first place.
      sessionStorage.removeItem(FOREIGN_RELOAD_KEY);
    } catch (e) {
      log.error('[Bootstrap] Reset error:', e);
    }
  }

  /**
   * Whether a registration is the one this bootstrap registered.
   *
   * Matched on path, since the registered URL carries a `?v=` cache-buster.
   * With no configured filename to compare against we cannot tell ours from
   * anyone else's, and clearing the caching layer is the job we were asked
   * to do — so every registration is fair game in that case.
   */
  private isOwnRegistration(registration: ServiceWorkerRegistration): boolean {
    if (!this.swFilename) return true;

    const worker =
      registration.active ?? registration.waiting ?? registration.installing;
    if (!worker) return false;

    try {
      return (
        new URL(worker.scriptURL).pathname ===
        new URL(this.swFilename, document.baseURI).pathname
      );
    } catch {
      return false;
    }
  }

  private getCSS(): string {
    const color = this.config.color;
    const colorAlpha = withAlpha(color, '80');
    const isDark =
      this.config.theme === 'dark' ||
      (this.config.theme === 'auto' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    const bg = isDark ? '#1a1a2e' : '#f4fdf7';
    const subtextColor = isDark ? '#b0b0b0' : '#666';
    const headingColor = isDark ? '#ededed' : '#2b2c29';
    const trackColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
    // The accent is a brand colour, not a contrast ratio: the default
    // `#25D366` as the title on the light background is about 1.9:1. Text
    // gets a darkened or lightened variant that passes 4.5:1, and the
    // button a variant its white label has 3:1 against; the bar and the
    // glows keep the colour as given (audit #30, item 5.1).
    const titleColor = ensureContrast(color, bg);
    const buttonColor = ensureContrast(color, '#ffffff', 3);
    const errorColor = this.errorColor;

    return `
      html, body {
        background: ${bg};
      }
      #sw-loading {
        position: fixed;
        inset: 0;
        z-index: 999999;
        box-sizing: border-box;
        padding: 24px 16px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        /* A long message on a short viewport (a phone held in landscape)
           overflows a centred column in both directions, and the overflow
           above the top edge of a scroll container cannot be reached.
           \`safe\` drops to flex-start exactly when that would happen; the
           plain \`center\` above stays for browsers that drop the whole
           declaration. */
        justify-content: safe center;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        background: ${bg};
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: sw-fadeIn 0.6s ease-in;
      }
      @keyframes sw-fadeIn {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .sw-logo-container {
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 96px;
        height: 96px;
        margin-bottom: 1.25rem;
      }
      .sw-logo-image {
        width: 100%;
        height: 100%;
        /* The logo is whatever shape its author drew. Letterboxed inside
           the box above rather than stretched, and not clipped to a circle:
           the ring that used to justify that is gone. */
        object-fit: contain;
        transition: filter 0.45s ease, opacity 0.45s ease;
      }
      /* Stalled, and on the error screen, the artwork stops reading as
         work in progress. On the error screen it is also a still frame;
         see freezeLogo. */
      #sw-loading.is-stalled .sw-logo-image {
        filter: grayscale(1);
        opacity: 0.6;
      }
      .sw-title {
        font-size: 2rem;
        font-weight: 700;
        margin: 0;
        color: ${titleColor};
        max-width: 100%;
        overflow-wrap: anywhere;
        text-align: center;
      }
      /* One box for the headline and the status, tall enough for the
         tallest thing either state puts in it — a failure headline over
         two lines of explanation — with its contents sitting at the
         bottom. A one-line stage label and a three-line failure therefore
         leave the bar below them in the same place, so the column does not
         jump as the labels change length or the error screen arrives. */
      .sw-message {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        align-items: center;
        box-sizing: border-box;
        width: 100%;
        /* 100% of the padded root, so the gutter holds on every viewport —
           90vw sat under the scrollbar on desktop. The second bound keeps
           the line length readable on a wide one. */
        max-width: min(100%, 40rem);
        font-size: 1.1rem;
        line-height: 1.45;
        min-height: calc(3 * 1.45em);
        margin-top: 0.75rem;
      }
      .sw-error-title {
        font-size: 1em;
        font-weight: 700;
        margin: 0;
        color: ${headingColor};
        max-width: 100%;
        overflow-wrap: anywhere;
        text-align: center;
      }
      .sw-status {
        font-size: 1em;
        font-weight: 500;
        color: ${subtextColor};
        max-width: 100%;
        overflow-wrap: anywhere;
        text-align: center;
      }
      #sw-loading.is-error .sw-status {
        color: ${errorColor};
      }
      .sw-loading-dots::after {
        content: '...';
        display: inline-block;
        width: 1.5em;
        text-align: left;
        overflow: hidden;
        vertical-align: bottom;
        /* This box inherits \`overflow-wrap: anywhere\` from .sw-status, so
           nothing but \`white-space\` keeps the three dots on one line: the
           animation used to sweep the width from 0, and below ~0.75em they
           wrapped onto three lines inside the box. It grew three lines tall
           and \`vertical-align: bottom\` hung the extra two above the
           message — the reported glitch. */
        white-space: pre;
        animation: sw-dots 1.5s steps(4, end) infinite;
      }
      /* Clipped rather than resized: a width sweep changes the box's
         footprint mid-cycle, so on a line the message nearly fills the dots
         jumped to a line of their own and back, shifting everything below
         them. The insets match the widths this used to animate. */
      @keyframes sw-dots {
        0%, 100% { clip-path: inset(0 1.5em 0 0); }
        25% { clip-path: inset(0 1em 0 0); }
        50% { clip-path: inset(0 0.5em 0 0); }
        75% { clip-path: inset(0 0 0 0); }
      }
      .sw-progress {
        flex: none;
        box-sizing: border-box;
        width: min(100%, 20rem);
        height: 6px;
        margin-top: 1rem;
        border-radius: 999px;
        background: ${trackColor};
        overflow: hidden;
      }
      .sw-progress-fill {
        width: 0%;
        height: 100%;
        border-radius: inherit;
        background: ${color};
        box-shadow: 0 0 8px ${colorAlpha};
        transition: width 0.3s ease;
      }
      .sw-percentage {
        font-size: 0.9rem;
        color: ${subtextColor};
        opacity: 0.7;
        margin-top: 0.5rem;
      }
      /* The failure is final: a bar frozen part-way and a percentage that
         will never reach 100 only invite the user to keep waiting. */
      #sw-loading.is-error .sw-progress,
      #sw-loading.is-error .sw-percentage {
        display: none;
      }
      /* Laid out only once it is offered. An invisible button still took
         keyboard focus, with an invisible focus ring, and Enter reloaded
         the page mid-download; screen readers listed it too. */
      .sw-actions {
        display: none;
        margin-top: 1.25rem;
      }
      #sw-loading.is-stalled .sw-actions {
        display: flex;
      }
      .sw-action {
        font: inherit;
        font-size: 1rem;
        font-weight: 600;
        line-height: 1.3;
        max-width: 100%;
        padding: 0.7rem 1.6rem;
        border: none;
        border-radius: 999px;
        background: ${buttonColor};
        color: #fff;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
        transition:
          transform 0.2s ease,
          box-shadow 0.3s ease,
          opacity 0.2s ease;
        animation: sw-action-in 0.35s ease-out both;
      }
      @keyframes sw-action-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .sw-action:hover {
        transform: translateY(-1px);
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
      }
      .sw-action:active {
        transform: translateY(0) scale(0.98);
      }
      .sw-action:focus-visible {
        outline: none;
        box-shadow:
          0 6px 18px rgba(0, 0, 0, 0.18),
          0 0 0 4px ${colorAlpha};
      }
      .sw-action:disabled,
      .sw-action.is-loading {
        cursor: wait;
        opacity: 0.75;
      }
      @media (max-width: 480px) {
        .sw-logo-container { width: 80px; height: 80px; margin-bottom: 1rem; }
        .sw-title { font-size: 1.6rem; }
      }
      /* A phone in landscape leaves ~320px of height. Last, so it also
         trims the block above on a short *and* narrow viewport. */
      @media (max-height: 480px) {
        #sw-loading { padding: 16px; }
        .sw-logo-container { width: 56px; height: 56px; margin-bottom: 0.5rem; }
        .sw-title { font-size: 1.4rem; }
        .sw-message { font-size: 1rem; margin-top: 0.5rem; }
        .sw-progress { margin-top: 0.75rem; }
        .sw-percentage { margin-top: 0.25rem; }
        .sw-actions { margin-top: 0.75rem; }
        .sw-action { padding: 0.55rem 1.25rem; font-size: 0.95rem; }
      }
      @media (prefers-reduced-motion: reduce) {
        #sw-loading { animation: none; }
        .sw-loading-dots::after { animation: none; }
        .sw-progress-fill { transition: none; }
        .sw-logo-image { transition: none; }
        .sw-action { animation: none; transition: none; }
      }
    `;
  }
}
