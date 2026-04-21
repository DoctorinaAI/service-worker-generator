import type { ProgressState, BootstrapPhase } from '../shared/types';
import type { LoadingWidget } from './loading-widget';
import { logProgress } from './console-logger';
import { activateWaitingSW } from './sw-registration';

type ProgressCallback = (state: ProgressState) => void;
type UpdateHandler = () => void | Promise<void>;

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
  private updateHandlers = new Set<UpdateHandler>();
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
   * Subscribe to "a new service worker has installed and is waiting" events.
   * Handlers typically prompt the user to reload to pick up the new build.
   * Returns an unsubscribe function.
   */
  onUpdateAvailable(handler: UpdateHandler): () => void {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }

  /**
   * Internal: fire registered update handlers. Safe if none are set.
   *
   * Intentionally `_disposed`-agnostic. The `sw-update-available` event can
   * legitimately arrive any time during the page session — typically several
   * seconds after `flutter-first-frame` has already triggered `dispose()` —
   * so the handler set must remain reachable past dispose. See `dispose()`
   * below and the bridge listener installed by `runPipeline` in
   * `pipeline.ts`.
   *
   * Async handlers (`UpdateHandler` is `() => void | Promise<void>`) have
   * their rejections routed to `console.error` so they don't surface as
   * "Uncaught (in promise)" warnings that mask the real error.
   */
  notifyUpdateAvailable(): void {
    for (const h of this.updateHandlers) {
      try {
        const result = h();
        if (result instanceof Promise) {
          result.catch((error) =>
            console.error(
              '[Bootstrap] onUpdateAvailable async handler rejected:',
              error,
            ),
          );
        }
      } catch (error) {
        console.error('[Bootstrap] onUpdateAvailable handler threw:', error);
      }
    }
  }

  /**
   * Remove loading widget and clean up. Called by Dart when the app is
   * ready (typically via `window.removeLoadingIndicator()` or the
   * automatic `flutter-first-frame` listener in `pipeline.ts`).
   *
   * `updateHandlers` are intentionally NOT cleared here. They model
   * app-lifetime concerns — a newer Service Worker can install at any
   * moment during the session (see `wireUpdateDetection` in
   * `sw-registration.ts`) — whereas `subscribers` and the loading widget
   * are load-phase only. Clearing update handlers here would silently
   * kill the "update available" UX after the loading screen disappears.
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
    onUpdateAvailable: (h: UpdateHandler) => api.onUpdateAvailable(h),
    /**
     * Apply a waiting SW update and reload the page. Resolves to `false`
     * when no update is pending or SW is unavailable — caller can use that
     * to decide whether to show "you're up to date" UI.
     */
    applyUpdate: async (reload = true): Promise<boolean> => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return false;
      const ok = await activateWaitingSW(reg);
      if (ok && reload) window.location.reload();
      return ok;
    },
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
