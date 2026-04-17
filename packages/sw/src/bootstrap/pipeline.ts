import type { BuildConfig, SWProgressMessage } from '../shared/types';
import { STAGE_PROGRESS } from '../shared/constants';
import { formatBytes } from '../shared/utils';
import type { ResolvedConfig } from './config';
import { BootstrapAPI } from './api';
import { LoadingWidget } from './loading-widget';
import { logPhase, logProgress } from './console-logger';
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
    const mapped = mapProgress(internalPercent);
    api.update(phase, mapped, message);
    logProgress(mapped, message);
  };

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
    const swRegistration = await registerServiceWorker(
      build.swFilename,
      build.swVersion,
    );

    // Set up SW message listener for download progress
    let cleanupSWListener: (() => void) | null = null;
    const totalResourcesSize = { value: 0 };
    const loadedResources = new Map<string, { size: number; loaded: number }>();

    if (swRegistration) {
      cleanupSWListener = listenForSWMessages((data) => {
        const msg = data as SWProgressMessage;
        if (!msg.resourceKey) return;

        totalResourcesSize.value = msg.resourcesSize || totalResourcesSize.value;
        loadedResources.set(msg.resourceKey, {
          size: msg.resourceSize,
          loaded: msg.loaded,
        });

        // Calculate aggregate progress
        let totalLoaded = 0;
        let totalSize = 0;
        for (const r of loadedResources.values()) {
          totalLoaded += r.loaded;
          totalSize += r.size;
        }
        totalSize = Math.max(totalSize, 3 * 1024 * 1024); // min 3MB fallback

        const downloadPercent = Math.min((totalLoaded / totalSize) * 100, 100);
        // Map download progress from CanvasKit stage to Assets stage (20% → 80%)
        const internalPercent =
          STAGE_PROGRESS.canvaskit +
          (downloadPercent / 100) *
            (STAGE_PROGRESS.assets - STAGE_PROGRESS.canvaskit);

        updateProgress(
          'assets',
          internalPercent,
          `Downloading (${formatBytes(totalLoaded)} / ${formatBytes(totalSize)})`,
        );
      });
    }

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

    // Stage 6: Dart takes over
    updateProgress('dart-init', STAGE_PROGRESS.dartEntry, 'Application started');

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
