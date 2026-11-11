import type {
  ProgressState,
  BootstrapPhase,
  SWLifecycleMessage,
} from '../shared/types';
import type { LoadingWidget } from './loading-widget';
import { logProgress } from './console-logger';
import { activateWaitingSW } from './sw-registration';
import { log } from '../shared/logger';

type ProgressCallback = (state: ProgressState) => void;
type UpdateHandler = () => void | Promise<void>;
type ErrorHandler = (state: Readonly<ProgressState>) => void | Promise<void>;
type WorkerFailureHandler = (
  message: Readonly<SWLifecycleMessage>,
) => void | Promise<void>;

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
  private errorHandlers = new Set<ErrorHandler>();
  private workerFailureHandlers = new Set<WorkerFailureHandler>();
  private _disposed = false;
  private lastLoggedPercent = -1;

  /** `null` when the page asked for no loading screen (`showWidget`). */
  constructor(private widget: LoadingWidget | null) {}

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
    // A failure is the end of this load. The service worker keeps
    // narrating its own install long after the page has given up — it
    // reports to every client, controlled or not — and so does a Dart app
    // that called `updateLoadingProgress` before it died. Letting any of
    // that through replaced the sentence the user was given with a
    // resource counter in error red, and left `Bootstrap.progress` with no
    // trace of the error anyone subscribed for.
    if (this._state.phase === 'error') return;

    this._state = { phase, percent, message };
    this.guardWidget('updateProgress', () =>
      this.widget?.updateProgress(percent, message),
    );

    for (const cb of this.subscribers) {
      try {
        cb(this._state);
      } catch (e) {
        log.error('[Bootstrap] Subscriber error:', e);
      }
    }
  }

  /**
   * Forward-only update that also writes a console log line.
   * Used by pipeline stages and window.updateLoadingProgress so stale
   * or late callbacks cannot regress the displayed percent.
   */
  updateAndLog(phase: BootstrapPhase, percent: number, message: string): void {
    // After a failure `update` ignores this, and so must the console: a
    // progress line printed after the error read as a load that went on.
    if (this._disposed || this._state.phase === 'error') return;
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
   * Show a failure: in the widget, in the progress state, and to the
   * handlers registered with [onError].
   *
   * [message] is what the user reads; [detail] is the raw reason — an
   * engine message such as `WebAssembly.instantiate(): Import #3 …` — kept
   * out of the widget and handed to consumers that report failures.
   *
   * The state is published even after dispose: a failure that arrives once
   * the app is running still concerns whoever asked to hear about them.
   */
  error(message: string, detail?: string): void {
    this._state = {
      phase: 'error',
      percent: this._state.percent,
      message,
      ...(detail ? { detail } : {}),
    };
    this.guardWidget('showError', () => this.widget?.showError(message));
    for (const cb of this.subscribers) {
      try {
        cb(this._state);
      } catch (e) {
        log.error('[Bootstrap] Subscriber error:', e);
      }
    }
    for (const handler of this.errorHandlers) {
      try {
        void handler(this._state);
      } catch (e) {
        log.error('[Bootstrap] Error handler threw:', e);
      }
    }
  }

  /**
   * Internal: hand a worker lifecycle failure to the registered handlers.
   *
   * Not an `error()`: the app is loading or already running, and a cache
   * the worker could not write is a degraded caching layer rather than a
   * failed load. Handlers that report errors want to hear about it all the
   * same.
   */
  notifyWorkerFailure(message: SWLifecycleMessage): void {
    for (const handler of this.workerFailureHandlers) {
      try {
        void handler(message);
      } catch (e) {
        log.error('[Bootstrap] Worker failure handler threw:', e);
      }
    }
  }

  /**
   * Subscribe to service worker failures — a failed install, a cache swap
   * that ran out of storage, a cache write that was refused. Returns an
   * unsubscribe function.
   */
  onWorkerFailure(handler: WorkerFailureHandler): () => void {
    this.workerFailureHandlers.add(handler);
    return () => this.workerFailureHandlers.delete(handler);
  }

  /**
   * Subscribe to loading failures. Handlers receive the `error` state,
   * whose `detail` carries the raw reason. Returns an unsubscribe
   * function.
   */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * Run a widget call that must never break loading. The widget only
   * renders; an exception there (a strict CSP, Trusted Types, a DOM the
   * page changed underneath it) is logged and the pipeline goes on.
   */
  private guardWidget(step: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      log.error(`[Bootstrap] Loading widget ${step} failed:`, e);
    }
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
        if (result && typeof (result as PromiseLike<void>).then === 'function') {
          (result as Promise<void>).catch((error) =>
            log.error(
              '[Bootstrap] onUpdateAvailable async handler rejected:',
              error,
            ),
          );
        }
      } catch (error) {
        log.error('[Bootstrap] onUpdateAvailable handler threw:', error);
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
    this.guardWidget('dispose', () => this.widget?.dispose());
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
    onError: (h: ErrorHandler) => api.onError(h),
    onWorkerFailure: (h: WorkerFailureHandler) => api.onWorkerFailure(h),
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
