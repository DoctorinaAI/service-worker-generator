import type { FlutterBuildEntry } from '../shared/types';
import { STAGE_PROGRESS } from '../shared/constants';
import { logPhase } from './console-logger';
import { log } from '../shared/logger';

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
 * before. A failure of `runApp()` — Dart's `main` throwing before the
 * first frame — goes the same way, for the same reason.
 *
 * [messages] are what the loading screen says during the last two stages,
 * resolved from `data-config.strings`.
 */
export async function loadFlutterApp(
  canvasKitBaseUrl: string,
  engineRevision: string,
  builds: FlutterBuildEntry[],
  onProgress: (percent: number, message: string) => void,
  onEngineError?: (error: unknown) => void,
  messages: { initializing: string; running: string } = {
    initializing: 'Initializing Flutter engine',
    running: 'Starting application',
  },
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
      onProgress(STAGE_PROGRESS.dartEntryLoaded, messages.initializing);
      logPhase('Flutter', 'Entry point loaded, initializing engine');

      // Disable pointer events during init
      const flutterView = document.querySelector(
        'flutter-view',
      ) as HTMLElement | null;
      if (flutterView) {
        flutterView.style.pointerEvents = 'none';
      }

      const fail = (phase: string, error: unknown): never => {
        logPhase('Flutter', phase);
        try {
          onEngineError?.(error);
        } catch (handlerError) {
          log.error('[Bootstrap] Engine error handler threw:', handlerError);
        }
        throw error;
      };

      let appRunner: FlutterAppRunner;
      try {
        appRunner = await engineInitializer.initializeEngine();
      } catch (error) {
        return fail('Engine initialization failed', error);
      }
      onProgress(STAGE_PROGRESS.dartEntry, messages.running);
      logPhase('Flutter', 'Engine initialized, running app');

      try {
        await appRunner.runApp();
      } catch (error) {
        return fail('App failed to start', error);
      }
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
