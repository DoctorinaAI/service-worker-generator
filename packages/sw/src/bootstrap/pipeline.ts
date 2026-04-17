import type { BuildConfig, SWProgressMessage } from '../shared/types';
import { STAGE_PROGRESS } from '../shared/constants';
import type { ResolvedConfig } from './config';
import { BootstrapAPI } from './api';
import { LoadingWidget } from './loading-widget';
import { logPhase } from './console-logger';
import {
  registerServiceWorker,
  listenForSWMessages,
} from './sw-registration';
import {
  detectBrowserCaps,
  selectBuild,
  loadCanvasKit,
} from './canvaskit-loader';
import { loadFlutterApp } from './flutter-loader';

/**
 * Run the full bootstrap pipeline.
 */
export async function runPipeline(config: ResolvedConfig): Promise<BootstrapAPI> {
  const { build, ui } = config;

  // Create loading widget and API
  const widget = new LoadingWidget(ui);
  const api = new BootstrapAPI(widget);

  // Mount the widget
  widget.mount();

  // Map internal progress (0-100) to configured range
  const mapProgress = (internal: number): number => {
    return ui.minProgress + (internal / 100) * (ui.maxProgress - ui.minProgress);
  };

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

          // Adopt the count from any message (including the initial
          // empty-key install announce) so we have a denominator early.
          if (msg.resourcesCount) totalResourcesCount = msg.resourcesCount;
          if (!msg.resourceKey) return;

          // Terminal states advance the counter; 'loading' is the in-flight
          // announce and 'error' does not count as progress.
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
          // Map download progress from CanvasKit stage to Assets stage (20% → 80%)
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

    // Clean up SW listener
    if (cleanupSWListener) {
      cleanupSWListener();
    }

    // Dart takes over from here. onEntrypointLoaded in flutter-loader has
    // already moved progress to STAGE_PROGRESS.dartEntry (90%); any further
    // reporting comes from main.dart via window.updateLoadingProgress.

    // Listen for flutter-first-frame as auto-dispose fallback
    window.addEventListener(
      'flutter-first-frame',
      () => {
        if (!api.disposed) {
          api.dispose();
        }
      },
      { once: true },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load application';
    console.error('[Bootstrap] Pipeline error:', error);
    api.error(message);
  }

  return api;
}
