import type { SWProgressMessage } from '../shared/types';
import { STAGE_PROGRESS } from '../shared/constants';
import type { ResolvedConfig } from './config';
import { BootstrapAPI } from './api';
import { LoadingWidget } from './loading-widget';
import { logPhase } from './console-logger';
import {
  registerServiceWorker,
  listenForSWMessages,
  reloadIfForeignController,
} from './sw-registration';
import {
  detectBrowserCaps,
  selectBuild,
  loadCanvasKit,
} from './canvaskit-loader';
import { loadFlutterApp } from './flutter-loader';

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
  const widget = new LoadingWidget(ui);
  const api = new BootstrapAPI(widget);
  widget.mount();

  // Bridge the `sw-update-available` CustomEvent (fired by sw-registration
  // when a newer SW finishes installing) into `api.onUpdateAvailable`
  // handlers. NOT once-bound: a long-lived tab can encounter multiple
  // deploys, and each must reach registered handlers (the user may dismiss
  // the first prompt and stay on the tab through a second release). The
  // underlying event is dispatched at most once per SW install, so no
  // debouncing is needed at this layer.
  const onSwUpdate = (): void => api.notifyUpdateAvailable();
  window.addEventListener('sw-update-available', onSwUpdate);

  void runPipelineWork(api, config);
  return api;
}

async function runPipelineWork(
  api: BootstrapAPI,
  config: ResolvedConfig,
): Promise<void> {
  const { build, ui } = config;

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
  updateProgress('init', STAGE_PROGRESS.start, 'Starting');

  // Attach the SW message listener BEFORE registering so we don't miss
  // install-time progress messages (navigator.serviceWorker does not
  // buffer messages posted before a listener is attached).
  const completedKeys = new Set<string>();
  let totalResourcesCount = 0;
  const cleanupSWListener: (() => void) | null =
    'serviceWorker' in navigator
      ? listenForSWMessages((data) => {
          const msg = data as SWProgressMessage;

          if (msg.resourcesCount) totalResourcesCount = msg.resourcesCount;
          if (!msg.resourceKey) return;

          if (
            msg.status === 'completed' ||
            msg.status === 'cached' ||
            msg.status === 'updated'
          ) {
            completedKeys.add(msg.resourceKey);
          }

          if (totalResourcesCount === 0) return;

          const done = completedKeys.size;
          const downloadPercent = Math.min(
            (done / totalResourcesCount) * 100,
            100,
          );
          const internalPercent =
            STAGE_PROGRESS.canvaskit +
            (downloadPercent / 100) *
              (STAGE_PROGRESS.assets - STAGE_PROGRESS.canvaskit);

          updateProgress(
            'assets',
            internalPercent,
            `Loaded ${done} of ${totalResourcesCount} resources`,
          );
        })
      : null;

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
    updateProgress('init', STAGE_PROGRESS.init, 'Checking environment');
    logPhase('Init', 'Detecting browser capabilities');
    const caps = detectBrowserCaps();
    logPhase(
      'Init',
      `WebGL: ${caps.webGLVersion}, WasmGC: ${caps.supportsWasmGC}, ` +
        `ImageCodecs: ${caps.hasImageCodecs}`,
    );

    // Stage 2: Service Worker
    updateProgress('sw', STAGE_PROGRESS.sw, 'Registering service worker');
    await registerServiceWorker(build.swFilename, build.swVersion);

    // Stage 3: CanvasKit
    updateProgress(
      'canvaskit',
      STAGE_PROGRESS.canvaskit,
      'Loading rendering engine',
    );

    const activeBuild = selectBuild(build.builds, caps);
    if (!activeBuild) {
      throw new Error('No compatible Flutter build found for this browser');
    }

    const canvasKitBaseUrl = await loadCanvasKit(
      build.engineRevision,
      activeBuild,
      caps,
    );

    // Stage 4-5: Assets + Dart Entry
    updateProgress('assets', STAGE_PROGRESS.canvaskit + 5, 'Loading application');

    await loadFlutterApp(
      canvasKitBaseUrl,
      build.engineRevision,
      build.builds,
      (percent, message) => {
        updateProgress('dart-entry', percent, message);
      },
    );

    // Auto-dispose on first frame.
    window.addEventListener(
      'flutter-first-frame',
      () => {
        if (!api.disposed) api.dispose();
      },
      { once: true },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load application';
    console.error('[Bootstrap] Pipeline error:', error);
    api.error(message);
  } finally {
    cleanupSWListener?.();
  }
}
