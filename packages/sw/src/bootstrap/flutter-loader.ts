import { logPhase } from './console-logger';

/**
 * Dynamically load Flutter's flutter.js and call its loader.
 * flutter.js must exist in the build output.
 */
export async function loadFlutterApp(
  canvasKitBaseUrl: string,
  onProgress: (percent: number, message: string) => void,
): Promise<void> {
  // Load flutter.js dynamically
  await loadScript('flutter.js');
  logPhase('Flutter', 'flutter.js loaded');

  // Wait for _flutter.loader to be available
  const flutter = (window as FlutterWindow)._flutter;
  if (!flutter?.loader) {
    throw new Error('_flutter.loader not available after loading flutter.js');
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
      onProgress(85, 'Initializing Flutter engine');
      logPhase('Flutter', 'Entry point loaded, initializing engine');

      // Disable pointer events during init
      const flutterView = document.querySelector(
        'flutter-view',
      ) as HTMLElement | null;
      if (flutterView) {
        flutterView.style.pointerEvents = 'none';
      }

      const appRunner = await engineInitializer.initializeEngine();
      onProgress(90, 'Starting application');
      logPhase('Flutter', 'Engine initialized, running app');

      await appRunner.runApp();
      logPhase('Flutter', 'App started');
    },
  });
}

/**
 * Load a script dynamically.
 */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.type = 'application/javascript';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

// Type declarations for Flutter's global API
interface FlutterWindow extends Window {
  _flutter?: {
    loader?: {
      load(options: FlutterLoadOptions): Promise<void>;
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
