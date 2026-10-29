import type { FlutterBuildEntry } from '../shared/types';
import { STAGE_PROGRESS } from '../shared/constants';
import { logPhase } from './console-logger';

/**
 * `window._flutter.loader` is missing: `bootstrap.js` was not produced by
 * the generator, which inlines `flutter.js`. No engine source fixes this,
 * so the pipeline shows it instead of retrying with the local CanvasKit.
 */
export class FlutterLoaderMissingError extends Error {
  constructor() {
    super(
      '_flutter.loader not available — flutter.js was not inlined ' +
        'into bootstrap.js (regenerate with "dart run sw:generate")',
    );
    this.name = 'FlutterLoaderMissingError';
  }
}

/**
 * Call Flutter's loader to start the app.
 *
 * The generator prepends Flutter's `flutter.js` IIFE to `bootstrap.js` at
 * generation time, so `window._flutter.loader` is already defined by the
 * time this runs — no runtime script fetch, no hard dependency on a
 * separate `flutter.js` file being present on the server.
 *
 * [onEngineError] receives a failure of `initializeEngine()`. flutter.js
 * calls `onEntrypointLoaded` without awaiting it, so such a failure (for
 * example a blocked `canvaskit.wasm`) never rejects the returned promise.
 * The error is still rethrown, so flutter.js and the console see it as
 * before.
 */
export async function loadFlutterApp(
  canvasKitBaseUrl: string,
  engineRevision: string,
  builds: FlutterBuildEntry[],
  onProgress: (percent: number, message: string) => void,
  onEngineError?: (error: unknown) => void,
): Promise<void> {
  // FlutterLoader.load() reads _flutter.buildConfig to pick the compatible
  // build, so seed it before invoking the loader.
  const w = window as FlutterWindow;
  w._flutter ??= {};
  w._flutter.buildConfig = { engineRevision, builds };

  const flutter = w._flutter;
  if (!flutter?.loader) throw new FlutterLoaderMissingError();

  logPhase('Flutter', 'Starting Flutter loader');

  await flutter.loader.load({
    config: {
      canvasKitBaseUrl: canvasKitBaseUrl.endsWith('/')
        ? canvasKitBaseUrl
        : `${canvasKitBaseUrl}/`,
    },
    onEntrypointLoaded: async (
      engineInitializer: FlutterEngineInitializer,
    ) => {
      onProgress(STAGE_PROGRESS.dartEntryLoaded, 'Initializing Flutter engine');
      logPhase('Flutter', 'Entry point loaded, initializing engine');

      // Disable pointer events during init
      const flutterView = document.querySelector(
        'flutter-view',
      ) as HTMLElement | null;
      if (flutterView) {
        flutterView.style.pointerEvents = 'none';
      }

      let appRunner: FlutterAppRunner;
      try {
        appRunner = await engineInitializer.initializeEngine();
      } catch (error) {
        logPhase('Flutter', 'Engine initialization failed');
        try {
          onEngineError?.(error);
        } catch (handlerError) {
          console.error('[Bootstrap] Engine error handler threw:', handlerError);
        }
        throw error;
      }
      onProgress(STAGE_PROGRESS.dartEntry, 'Starting application');
      logPhase('Flutter', 'Engine initialized, running app');

      await appRunner.runApp();
      logPhase('Flutter', 'App started');
    },
  });
}

// Type declarations for Flutter's global API
interface FlutterWindow extends Window {
  _flutter?: {
    loader?: {
      load(options: FlutterLoadOptions): Promise<void>;
    };
    buildConfig?: {
      engineRevision: string;
      builds: FlutterBuildEntry[];
    };
  };
}

interface FlutterLoadOptions {
  config?: {
    canvasKitBaseUrl?: string;
    renderer?: string;
  };
  onEntrypointLoaded?: (
    engineInitializer: FlutterEngineInitializer,
  ) => Promise<void>;
}

interface FlutterEngineInitializer {
  initializeEngine(): Promise<FlutterAppRunner>;
}

interface FlutterAppRunner {
  runApp(): Promise<void>;
}
