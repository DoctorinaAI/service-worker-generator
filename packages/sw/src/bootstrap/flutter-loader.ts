import type { FlutterBuildEntry } from '../shared/types';
import { STAGE_PROGRESS } from '../shared/constants';
import { logPhase } from './console-logger';

/**
 * Call Flutter's loader to start the app.
 *
 * The generator prepends Flutter's `flutter.js` IIFE to `bootstrap.js` at
 * generation time, so `window._flutter.loader` is already defined by the
 * time this runs — no runtime script fetch, no hard dependency on a
 * separate `flutter.js` file being present on the server.
 */
export async function loadFlutterApp(
  canvasKitBaseUrl: string,
  engineRevision: string,
  builds: FlutterBuildEntry[],
  onProgress: (percent: number, message: string) => void,
): Promise<void> {
  // FlutterLoader.load() reads _flutter.buildConfig to pick the compatible
  // build, so seed it before invoking the loader.
  const w = window as FlutterWindow;
  w._flutter ??= {};
  w._flutter.buildConfig = { engineRevision, builds };

  const flutter = w._flutter;
  if (!flutter?.loader) {
    throw new Error(
      '_flutter.loader not available — flutter.js was not inlined ' +
        'into bootstrap.js (regenerate with "dart run sw:generate")',
    );
  }

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

      const appRunner = await engineInitializer.initializeEngine();
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
