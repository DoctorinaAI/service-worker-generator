import type { ProgressState, BootstrapPhase } from '../shared/types';
import type { LoadingWidget } from './loading-widget';
import { logProgress } from './console-logger';

type ProgressCallback = (state: ProgressState) => void;

/**
 * Global Bootstrap API exposed as window.Bootstrap.
 */
export class BootstrapAPI {
  private _state: ProgressState = {
    phase: 'init',
    percent: 0,
    message: 'Initializing',
  };
  private subscribers = new Set<ProgressCallback>();
  private _disposed = false;
  private lastLoggedPercent = -1;

  constructor(private widget: LoadingWidget) {}

  /** Current progress state (readonly). */
  get progress(): Readonly<ProgressState> {
    return { ...this._state };
  }

  /** Whether the bootstrap has been disposed. */
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Subscribe to progress changes.
   * Returns an unsubscribe function.
   */
  subscribe(callback: ProgressCallback): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /**
   * Update progress state and notify subscribers.
   */
  update(phase: BootstrapPhase, percent: number, message: string): void {
    if (this._disposed) return;

    this._state = { phase, percent, message };
    this.widget.updateProgress(percent, message);

    for (const cb of this.subscribers) {
      try {
        cb(this._state);
      } catch (e) {
        console.error('[Bootstrap] Subscriber error:', e);
      }
    }
  }

  /**
   * Forward-only update that also writes a console log line.
   * Used by pipeline stages and window.updateLoadingProgress so stale
   * or late callbacks cannot regress the displayed percent.
   */
  updateAndLog(phase: BootstrapPhase, percent: number, message: string): void {
    if (this._disposed) return;
    const prev = this.lastLoggedPercent;
    const prevMessage = this._state.message;
    const clamped = Math.max(prev, Math.min(percent, 100));
    this.lastLoggedPercent = clamped;
    this.update(phase, clamped, message);
    if (clamped > prev || message !== prevMessage) {
      logProgress(clamped, message);
    }
  }

  /**
   * Show an error in the loading widget.
   */
  error(message: string): void {
    this.widget.showError(message);
  }

  /**
   * Remove loading widget and clean up.
   * Called by Dart when app is ready.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.widget.dispose();
    this.subscribers.clear();
  }
}

/**
 * Install the Bootstrap API as window.Bootstrap and expose
 * Dart-facing helpers (updateLoadingProgress, removeLoadingIndicator)
 * as top-level window functions for convenient JS-interop.
 */
export function installGlobalAPI(api: BootstrapAPI): void {
  const windowAny = window as unknown as Record<string, unknown>;
  windowAny['Bootstrap'] = {
    get progress() {
      return api.progress;
    },
    subscribe: (cb: ProgressCallback) => api.subscribe(cb),
    dispose: () => api.dispose(),
  };

  // Flutter/Dart interop: mutate progress and dismiss the widget from Dart.
  // Progress is expected in the 0-100 range that the widget already uses.
  // Route through updateAndLog so every Dart-side progress call lands in
  // the console alongside pipeline stages.
  windowAny['updateLoadingProgress'] = (progress: number, text?: string) => {
    const percent = Math.max(0, Math.min(100, Number(progress) || 0));
    api.updateAndLog('dart-init', percent, text ?? api.progress.message);
  };
  windowAny['removeLoadingIndicator'] = () => api.dispose();
}
