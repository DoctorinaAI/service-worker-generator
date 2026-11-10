import type { SWProgressMessage } from '../shared/types';
import { STAGE_PROGRESS } from '../shared/constants';
import { format, type StringKey } from '../shared/strings';
import type { ResolvedConfig } from './config';
import { BootstrapAPI } from './api';
import { LoadingWidget } from './loading-widget';
import { logPhase } from './console-logger';
import {
  controllerVersion,
  forwardLifecycleEvents,
  registerServiceWorker,
  listenForSWMessages,
  reloadIfForeignController,
  settleUpdateAtBootstrap,
} from './sw-registration';
import {
  detectBrowserCaps,
  selectBuild,
  getCanvasKitVariant,
  loadCanvasKit,
  isCdnEngineFailure,
  reloadWithLocalCanvasKit,
} from './canvaskit-loader';
import { CANVASKIT_LOCAL_PATH } from '../shared/constants';
import { FlutterLoaderMissingError, loadFlutterApp } from './flutter-loader';
import { log } from '../shared/logger';

/**
 * Start the bootstrap pipeline.
 *
 * Creates the loading widget and BootstrapAPI synchronously, then kicks off
 * the async work as fire-and-forget. The API is returned immediately so the
 * caller can install window globals before any await yields — this lets
 * Dart code (which runs inside flutter.loader.load) hit a populated
 * window.updateLoadingProgress from its very first invocation.
 */
export function runPipeline(config: ResolvedConfig): BootstrapAPI {
  const { ui } = config;
  const widget = new LoadingWidget(
    ui,
    config.build.swFilename,
    config.build.cachePrefix,
  );
  const api = new BootstrapAPI(widget);
  // The widget is cosmetic: a page with Trusted Types, a strict CSP or an
  // unusual DOM must still get its app, so a failed mount is logged and
  // the pipeline goes on without a loading screen.
  try {
    widget.mount();
  } catch (error) {
    log.error('[Bootstrap] Loading widget failed to mount; continuing without it:', error);
  }

  // Bridge the `sw-update-available` CustomEvent (fired by sw-registration
  // when a newer SW finishes installing) into `api.onUpdateAvailable`
  // handlers. NOT once-bound: a long-lived tab can encounter multiple
  // deploys, and each must reach registered handlers (the user may dismiss
  // the first prompt and stay on the tab through a second release). The
  // underlying event is dispatched at most once per SW install, so no
  // debouncing is needed at this layer.
  const onSwUpdate = (): void => api.notifyUpdateAvailable();
  window.addEventListener('sw-update-available', onSwUpdate);

  // The worker's own failures, for the page and for anything that reports
  // errors for the app. Installed for the life of the page: a quota error
  // or a failed swap arrives long after the loading screen is gone.
  forwardLifecycleEvents((message) => api.notifyWorkerFailure(message));

  void runPipelineWork(api, config, widget);
  return api;
}

async function runPipelineWork(
  api: BootstrapAPI,
  config: ResolvedConfig,
  widget: LoadingWidget,
): Promise<void> {
  const { build, ui } = config;

  /** What this page calls [key]; see `shared/strings.ts`. */
  const text = (key: StringKey): string => ui.strings[key];

  const mapProgress = (internal: number): number =>
    ui.minProgress + (internal / 100) * (ui.maxProgress - ui.minProgress);

  const updateProgress = (
    phase: Parameters<typeof api.update>[0],
    internalPercent: number,
    message: string,
  ): void => {
    api.updateAndLog(phase, mapProgress(internalPercent), message);
  };

  // Stage 0: visible 0% beat so the console shows bootstrap started.
  updateProgress('init', STAGE_PROGRESS.start, text('starting'));

  // Attach the SW message listener BEFORE registering so we don't miss
  // install-time progress messages (navigator.serviceWorker does not
  // buffer messages posted before a listener is attached).
  //
  // Two rules keep the counter honest, and both are load-bearing:
  //
  //  1. Only this build's worker may speak. During an update load an older
  //     worker still controls the page and broadcasts its own manifest's
  //     totals to every client, including this one. Its denominator need
  //     not match ours, and the last message to arrive would otherwise
  //     decide which one we render against.
  //  2. Only resources inside the counted set are added to the numerator.
  //     The SW reports every resource it serves, but `resourcesCount`
  //     covers the pre-cached set alone; lazily-cached resources served by
  //     the fetch handler are outside it. Counting them against that total
  //     is what produced `Loaded 5 of 4 resources`.
  const completedKeys = new Set<string>();
  /**
   * Bytes reported for each counted resource, the terminal ones pinned at
   * their full size.
   *
   * The percentage is rendered from these and the message from the count:
   * the pre-cached set is one or two multi-megabyte files next to a handful
   * of small ones, so counting files moves the ring in two jumps while
   * counting bytes moves it as the download goes. The count is still what
   * the message says, because "Loaded 3 of 5 resources" is something a
   * user can read.
   */
  const loadedBytes = new Map<string, number>();
  let totalResourcesCount = 0;
  let totalResourcesSize = 0;
  let foreignVersion: string | null = null;
  let sawOwnVersion = false;
  const cleanupSWListener: (() => void) | null =
    'serviceWorker' in navigator
      ? listenForSWMessages((data) => {
          const msg = data as SWProgressMessage;

          if (msg.swVersion !== build.swVersion) {
            // Routine during an update load: the old controller keeps
            // reporting against its own manifest while the new worker
            // installs, and the two denominators need not agree. Warning
            // here would fire on every healthy update, so only record it —
            // whether it was *every* message is not knowable until the
            // listener is torn down, and that is where it gets reported.
            foreignVersion = msg.swVersion;
            return;
          }
          if (!sawOwnVersion) {
            sawOwnVersion = true;
            // Something is narrating this load after all, so silence means
            // a stall again.
            widget.expectProgress();
          }

          // Latch the denominator once. A single worker reports a constant
          // `resourcesCount`, so this only guards against a mid-load change
          // ever becoming possible again.
          if (!totalResourcesCount && msg.resourcesCount) {
            totalResourcesCount = msg.resourcesCount;
            totalResourcesSize = msg.resourcesSize;
          }
          if (!totalResourcesCount) return;
          if (!msg.counted || !msg.resourceKey) return;

          const done =
            msg.status === 'completed' ||
            msg.status === 'cached' ||
            msg.status === 'updated';
          if (done) {
            completedKeys.add(msg.resourceKey);
            // Whatever the last beat said, a finished resource is all of it.
            loadedBytes.set(msg.resourceKey, msg.resourceSize);
          } else if (msg.status === 'loading' && msg.loaded > 0) {
            // Only forwards: a second worker, or a retry of the same file,
            // must not walk the ring backwards.
            const before = loadedBytes.get(msg.resourceKey) ?? 0;
            if (msg.loaded > before) loadedBytes.set(msg.resourceKey, msg.loaded);
          }

          // Within one worker `completedKeys` is a subset of the counted
          // set. The clamp covers the case that survives the version
          // filter: two builds generated with the same explicit
          // `--version` report different counted sets under one identity,
          // and their union can outrun the latched total. The number it
          // guards is rendered straight to the user.
          const count = Math.min(completedKeys.size, totalResourcesCount);
          // Bytes when the worker said how many there are in total, which
          // every release since the protocol gained `resourcesSize` does;
          // the count is the fallback, and the clamp is there for the same
          // reason as above.
          let downloadPercent: number;
          if (totalResourcesSize > 0) {
            let bytes = 0;
            for (const loaded of loadedBytes.values()) bytes += loaded;
            downloadPercent = Math.min(100, (bytes / totalResourcesSize) * 100);
          } else {
            downloadPercent = (count / totalResourcesCount) * 100;
          }
          const internalPercent =
            STAGE_PROGRESS.canvaskit +
            (downloadPercent / 100) *
              (STAGE_PROGRESS.assets - STAGE_PROGRESS.canvaskit);

          updateProgress(
            'assets',
            internalPercent,
            format(text('resources'), {
              done: count,
              total: totalResourcesCount,
            }),
          );
        })
      : null;

  /**
   * Stop listening and, if nothing this build's worker said ever arrived,
   * say so once.
   *
   * Called when the app has started — not when `loadFlutterApp` resolves:
   * flutter.js settles `load()` as soon as the entry point is fetched and
   * runs `onEntrypointLoaded` after that, so the engine's own files, and
   * every `sw-progress` about them, arrive later. Tearing down there froze
   * the counter at whatever install had reported and made the diagnosis
   * below fire in the middle of a healthy load (#39).
   */
  let listening = true;
  const stopListening = (): void => {
    if (!listening) return;
    listening = false;
    cleanupSWListener?.();
    // Only when the worker serving this page is from another build. During
    // an update load the previous controller reports its own manifest
    // before the handover, and that is no one's fault; the case worth a
    // line is a page whose controller stays a build this bootstrap knows
    // nothing about — usually a `bootstrap.js` served from the HTTP cache
    // without `Cache-Control: no-cache`.
    if (foreignVersion === null || sawOwnVersion) return;
    const controller = controllerVersion();
    if (controller === null || controller === build.swVersion) return;
    log.warn(
      `[Bootstrap] No sw-progress from v${build.swVersion}; every message ` +
        `came from v${String(foreignVersion)}, and v${controller} is still ` +
        `in control. This bootstrap and the service worker are from ` +
        `different builds, so the resource counter stayed empty. Check that ` +
        `bootstrap.js is served with Cache-Control: no-cache.`,
    );
  };
  window.addEventListener('flutter-first-frame', stopListening, { once: true });

  try {
    // Preflight: a foreign SW controller (Flutter's default SW, or an older
    // sw.js on a different path) can serve a mismatched mix of cached old
    // and network-fresh files during the transition deploy. That surfaces as
    // `WebAssembly.instantiate(): Import #N "X"` deep inside Flutter's
    // wasm loader. Detect and recover via a one-shot reload before any
    // fetch runs; the call bails early if there's no controller, the
    // controller matches, or we already reloaded once this tab session.
    if (await reloadIfForeignController(build.swFilename)) {
      return;
    }

    // Stage 1: Init
    updateProgress('init', STAGE_PROGRESS.init, text('environment'));
    logPhase('Init', 'Detecting browser capabilities');
    const caps = detectBrowserCaps();
    logPhase(
      'Init',
      `WebGL: ${caps.webGLVersion}, WasmGC: ${caps.supportsWasmGC}, ` +
        `ImageCodecs: ${caps.hasImageCodecs}`,
    );

    // Stage 2: Service Worker
    updateProgress('sw', STAGE_PROGRESS.sw, text('worker'));
    const registration = await registerServiceWorker(
      build.swFilename,
      build.swVersion,
    );
    // Waiting for a new engine's worker to install can outlast the
    // widget's stall threshold without a single `sw-progress`; the wait is
    // bounded on its own, so keep it from reading as a stall.
    if (
      registration &&
      (await settleUpdateAtBootstrap(
        registration,
        build.engineRevision,
        () => updateProgress('sw', STAGE_PROGRESS.sw, text('update')),
      ))
    ) {
      return;
    }

    // Stage 3: CanvasKit
    updateProgress('canvaskit', STAGE_PROGRESS.canvaskit, text('engine'));

    const activeBuild = selectBuild(build.builds, caps);
    if (!activeBuild) {
      throw new Error('No compatible Flutter build found for this browser');
    }

    const canvasKitBaseUrl = await loadCanvasKit(
      build.engineRevision,
      activeBuild,
      caps,
      build.useLocalCanvasKit ?? false,
    );

    // Auto-dispose on first frame. Registered before the app loads: the
    // first frame can be dispatched before `loadFlutterApp` resolves, and
    // a listener added after it would leave the widget up.
    window.addEventListener(
      'flutter-first-frame',
      () => {
        if (!api.disposed) api.dispose();
      },
      { once: true },
    );

    // Stage 4-5: Assets + Dart Entry
    updateProgress('assets', STAGE_PROGRESS.canvaskit + 5, text('app'));

    // Everything from here is the engine and the app downloading, and the
    // only thing that reports on it is the worker serving this page. If
    // that is not this build's worker — a first visit whose activation did
    // not land, a registration that failed, Firefox's private mode, iOS
    // Lockdown Mode — the page's own fetches are unnarrated, and 30 s of
    // silence is a slow link rather than a stall. The overlay's reset
    // would throw away the download in progress.
    if (controllerVersion() !== build.swVersion) {
      widget.expectSilence();
    }

    // An engine served from the CDN passed a one-byte probe of its `.js`,
    // which says nothing about the `.wasm`. If the app then fails because
    // of that engine, retry once with the local copy every build ships
    // (see `reloadWithLocalCanvasKit`); any other failure — the app's own
    // files, the network, being offline — shows the error screen, whose
    // reset button a reload would only hide (`isCdnEngineFailure`).
    // Failures arrive on two paths — a rejected `load()` and the
    // engine-init callback — and are handled once.
    const usedCdn = canvasKitBaseUrl !== CANVASKIT_LOCAL_PATH;
    const variant = getCanvasKitVariant(activeBuild, caps);
    let appFailureHandled = false;
    const handleAppFailure = async (error: unknown): Promise<void> => {
      if (
        usedCdn &&
        !(error instanceof FlutterLoaderMissingError) &&
        (await isCdnEngineFailure(error, canvasKitBaseUrl, variant))
      ) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reloadWithLocalCanvasKit(reason)) return;
      }
      reportPipelineError(api, ui, error);
    };
    const onAppFailure = (error: unknown): void => {
      if (appFailureHandled) return;
      appFailureHandled = true;
      // Nothing is loading any more, so nothing should narrate it. The
      // error state is terminal in the API too; this also releases the
      // listener, which otherwise lived until a first frame that is not
      // coming.
      stopListening();
      void handleAppFailure(error);
    };

    try {
      await loadFlutterApp(
        canvasKitBaseUrl,
        build.engineRevision,
        build.builds,
        (percent, message) => {
          updateProgress('dart-entry', percent, message);
        },
        onAppFailure,
      );
    } catch (error) {
      onAppFailure(error);
    }
  } catch (error) {
    reportPipelineError(api, ui, error);
    stopListening();
  }
}

/**
 * Show a failure to the user and hand the reason to whoever asked for it.
 *
 * The widget gets a sentence a user can act on; the engine's own message —
 * `WebAssembly.instantiate(): Import #3 "…"` — goes to the console and to
 * `Bootstrap.progress.detail`, where an error reporter can pick it up.
 * Showing that text on the loading screen told the user nothing and hid
 * what little they could do about it (audit #30, item 5.2).
 */
function reportPipelineError(
  api: BootstrapAPI,
  ui: ResolvedConfig['ui'],
  error: unknown,
): void {
  const detail = error instanceof Error ? error.message : String(error);
  log.error('[Bootstrap] Pipeline error:', error);
  api.error(ui.strings.failed, detail);
}
