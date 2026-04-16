import type { ResolvedConfig } from './config';
import { STALLED_TIMEOUT_MS } from '../shared/constants';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROGRESS_RING_RADIUS = 65;
const CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_RADIUS;

/**
 * Loading widget with circular progress, status text, and stall detection.
 */
export class LoadingWidget {
  private container: HTMLDivElement | null = null;
  private progressCircle: SVGCircleElement | null = null;
  private statusText: HTMLSpanElement | null = null;
  private percentageText: HTMLDivElement | null = null;
  private resetContainer: HTMLDivElement | null = null;
  private styleElement: HTMLStyleElement | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPercent = 0;
  private disposed = false;

  constructor(private config: ResolvedConfig['ui']) {}

  /**
   * Create and mount the loading widget into the DOM.
   */
  mount(): void {
    this.injectStyles();
    this.container = this.createDOM();
    document.body.appendChild(this.container);
    this.resetStallTimer();
  }

  /**
   * Update the progress display.
   */
  updateProgress(percent: number, message: string): void {
    if (this.disposed) return;

    // Only allow forward progress
    this.currentPercent = Math.max(this.currentPercent, Math.min(percent, 100));

    if (this.progressCircle) {
      const offset =
        CIRCUMFERENCE - (this.currentPercent / 100) * CIRCUMFERENCE;
      this.progressCircle.style.strokeDashoffset = String(offset);
    }

    if (this.statusText) {
      this.statusText.textContent = message;
    }

    if (this.percentageText && this.config.showPercentage) {
      this.percentageText.textContent = `${Math.round(this.currentPercent)}%`;
    }

    this.resetStallTimer();
  }

  /**
   * Show an error message in the widget.
   */
  showError(error: string): void {
    if (this.disposed || !this.statusText) return;
    this.statusText.textContent = error;
    this.statusText.style.color = '#ff4444';
    this.showResetButton();
  }

  /**
   * Remove the loading widget with a fade-out animation.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearStallTimer();

    if (this.container) {
      this.container.style.opacity = '0';
      this.container.style.transition = 'opacity 0.4s ease-out';
      this.container.addEventListener(
        'transitionend',
        () => {
          this.container?.remove();
          this.styleElement?.remove();
          this.container = null;
          this.styleElement = null;
        },
        { once: true },
      );
    }

    // Enable pointer events on Flutter view
    const flutterView = document.querySelector('flutter-view') as HTMLElement;
    if (flutterView) {
      flutterView.style.pointerEvents = 'auto';
    }
  }

  private injectStyles(): void {
    this.styleElement = document.createElement('style');
    this.styleElement.textContent = this.getCSS();
    document.head.appendChild(this.styleElement);
  }

  private createDOM(): HTMLDivElement {
    const container = document.createElement('div');
    container.id = 'sw-loading';

    // Logo with progress ring
    const logoContainer = document.createElement('div');
    logoContainer.className = 'sw-logo-container';

    // SVG progress ring
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sw-progress-ring');
    svg.setAttribute('viewBox', '0 0 140 140');

    const bgCircle = document.createElementNS(SVG_NS, 'circle');
    bgCircle.setAttribute('class', 'sw-progress-ring-bg');
    bgCircle.setAttribute('cx', '70');
    bgCircle.setAttribute('cy', '70');
    bgCircle.setAttribute('r', String(PROGRESS_RING_RADIUS));
    bgCircle.setAttribute('vector-effect', 'non-scaling-stroke');

    this.progressCircle = document.createElementNS(SVG_NS, 'circle');
    this.progressCircle.setAttribute('class', 'sw-progress-ring-fill');
    this.progressCircle.setAttribute('cx', '70');
    this.progressCircle.setAttribute('cy', '70');
    this.progressCircle.setAttribute('r', String(PROGRESS_RING_RADIUS));
    this.progressCircle.setAttribute('vector-effect', 'non-scaling-stroke');
    this.progressCircle.style.strokeDasharray = String(CIRCUMFERENCE);
    this.progressCircle.style.strokeDashoffset = String(CIRCUMFERENCE);

    svg.appendChild(bgCircle);
    svg.appendChild(this.progressCircle);
    logoContainer.appendChild(svg);

    // Logo image
    if (this.config.logo) {
      const img = document.createElement('img');
      img.src = this.config.logo;
      img.className = 'sw-logo-image';
      img.alt = 'Logo';
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

    // Status text
    const statusContainer = document.createElement('div');
    statusContainer.className = 'sw-status';
    this.statusText = document.createElement('span');
    this.statusText.textContent = 'Initializing';
    const dots = document.createElement('span');
    dots.className = 'sw-loading-dots';
    statusContainer.appendChild(this.statusText);
    statusContainer.appendChild(dots);
    container.appendChild(statusContainer);

    // Percentage
    if (this.config.showPercentage) {
      this.percentageText = document.createElement('div');
      this.percentageText.className = 'sw-percentage';
      this.percentageText.textContent = '0%';
      container.appendChild(this.percentageText);
    }

    // Reset button (hidden by default)
    this.resetContainer = document.createElement('div');
    this.resetContainer.className = 'sw-reset-container';
    this.resetContainer.style.display = 'none';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'sw-reset-button';
    resetBtn.textContent = '\u21BB Reset Cache';
    resetBtn.addEventListener('click', () => this.resetCache());
    this.resetContainer.appendChild(resetBtn);
    container.appendChild(this.resetContainer);

    return container;
  }

  private showResetButton(): void {
    if (this.resetContainer) {
      this.resetContainer.style.display = 'block';
    }
  }

  private resetStallTimer(): void {
    this.clearStallTimer();
    if (!this.disposed && this.currentPercent < 100) {
      this.stallTimer = setTimeout(() => {
        console.warn('[Bootstrap] Loading appears stalled');
        this.showResetButton();
      }, STALLED_TIMEOUT_MS);
    }
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private async resetCache(): Promise<void> {
    const btn = this.resetContainer?.querySelector('button');
    if (btn) {
      btn.textContent = '\u23F3 Resetting...';
      btn.setAttribute('disabled', 'true');
    }

    try {
      // Clear all caches
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }

      // Unregister all service workers
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }

      // Clear storage
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {
      console.error('[Bootstrap] Reset error:', e);
    }

    window.location.reload();
  }

  private getCSS(): string {
    const color = this.config.color;
    const colorAlpha = `${color}80`;
    const isDark =
      this.config.theme === 'dark' ||
      (this.config.theme === 'auto' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    const bg = isDark ? '#1a1a2e' : '#f4fdf7';
    const textColor = isDark ? '#e0e0e0' : '#333';
    const subtextColor = isDark ? '#b0b0b0' : '#666';
    const titleColor = isDark ? color : color;

    return `
      #sw-loading {
        position: fixed;
        inset: 0;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: ${bg};
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: sw-fadeIn 0.6s ease-in;
      }
      @keyframes sw-fadeIn {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .sw-logo-container {
        position: relative;
        display: inline-block;
        margin-bottom: 2rem;
      }
      .sw-progress-ring {
        position: absolute;
        top: -10px;
        left: -10px;
        width: 140px;
        height: 140px;
        transform: rotate(-90deg);
      }
      .sw-progress-ring-bg {
        fill: none;
        stroke: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'};
        stroke-width: 4;
      }
      .sw-progress-ring-fill {
        fill: none;
        stroke: ${color};
        stroke-width: 4;
        stroke-linecap: round;
        transition: stroke-dashoffset 0.3s ease;
        filter: drop-shadow(0 0 8px ${colorAlpha});
      }
      .sw-logo-image {
        width: 120px;
        height: 120px;
        border-radius: 50%;
        box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      }
      .sw-title {
        font-size: 2rem;
        font-weight: 700;
        margin: 0 0 1rem 0;
        color: ${titleColor};
      }
      .sw-status {
        font-size: 1.1rem;
        font-weight: 500;
        color: ${subtextColor};
        margin-top: 1rem;
      }
      .sw-loading-dots::after {
        content: '...';
        display: inline-block;
        width: 1.5em;
        text-align: left;
        overflow: hidden;
        vertical-align: bottom;
        animation: sw-dots 1.5s steps(4, end) infinite;
      }
      @keyframes sw-dots {
        0%, 100% { width: 0; }
        25% { width: 0.5em; }
        50% { width: 1em; }
        75% { width: 1.5em; }
      }
      .sw-percentage {
        font-size: 0.9rem;
        color: ${subtextColor};
        opacity: 0.7;
        margin-top: 0.5rem;
      }
      .sw-reset-container {
        margin-top: 2rem;
      }
      .sw-reset-button {
        padding: 12px 24px;
        background: ${color};
        border: 2px solid ${color};
        border-radius: 8px;
        color: white;
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s ease;
      }
      .sw-reset-button:hover {
        opacity: 0.85;
        transform: translateY(-2px);
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      }
      .sw-reset-button:active { transform: translateY(0); }
      .sw-reset-button:disabled { opacity: 0.5; cursor: not-allowed; }
      @media (max-width: 480px) {
        .sw-logo-image { width: 100px; height: 100px; }
        .sw-progress-ring { width: 120px; height: 120px; }
        .sw-title { font-size: 1.6rem; }
      }
    `;
  }
}
