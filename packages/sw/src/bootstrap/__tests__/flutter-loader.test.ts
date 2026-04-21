/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadFlutterApp } from '../flutter-loader';
import type { FlutterBuildEntry } from '../../shared/types';

interface FlutterWindow extends Window {
  _flutter?: {
    loader?: {
      load: (opts: unknown) => Promise<void>;
    };
    buildConfig?: {
      engineRevision: string;
      builds: FlutterBuildEntry[];
    };
  };
}

/**
 * The generator prepends Flutter's `flutter.js` IIFE to bootstrap.js, so
 * `window._flutter.loader` is already defined by the time `loadFlutterApp`
 * runs. These tests install a fake loader up-front to mimic that state.
 */
function installLoader(
  load: (opts: unknown) => Promise<void>,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(load);
  (window as FlutterWindow)._flutter = {
    ...(window as FlutterWindow)._flutter,
    loader: { load: spy as unknown as (opts: unknown) => Promise<void> },
  };
  return spy;
}

describe('loadFlutterApp', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete (window as FlutterWindow)._flutter;
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('seeds _flutter.buildConfig before calling the loader', async () => {
    let buildConfigAtCall: unknown;
    installLoader(async () => {
      buildConfigAtCall = (window as FlutterWindow)._flutter?.buildConfig;
    });

    const builds: FlutterBuildEntry[] = [{ renderer: 'canvaskit' }];
    await loadFlutterApp('/cdn/', 'rev', builds, vi.fn());

    expect(buildConfigAtCall).toEqual({ engineRevision: 'rev', builds });
    expect((window as FlutterWindow)._flutter?.buildConfig).toEqual({
      engineRevision: 'rev',
      builds,
    });
  });

  it('calls flutter.loader.load with canvasKitBaseUrl that always ends in "/"', async () => {
    const loadSpy = installLoader(async () => undefined);

    await loadFlutterApp('/cdn/base', 'rev', [{}], vi.fn());

    expect(loadSpy).toHaveBeenCalledOnce();
    const callArg = loadSpy.mock.calls[0][0] as {
      config: { canvasKitBaseUrl: string };
    };
    expect(callArg.config.canvasKitBaseUrl).toBe('/cdn/base/');
  });

  it('does not double-append "/" when base already ends with "/"', async () => {
    const loadSpy = installLoader(async () => undefined);

    await loadFlutterApp('/cdn/base/', 'rev', [{}], vi.fn());

    const callArg = loadSpy.mock.calls[0][0] as {
      config: { canvasKitBaseUrl: string };
    };
    expect(callArg.config.canvasKitBaseUrl).toBe('/cdn/base/');
  });

  it('fires progress callbacks for entrypointLoaded and engine init', async () => {
    const onProgress = vi.fn();
    const runApp = vi.fn(async () => undefined);
    const initializeEngine = vi.fn(async () => ({ runApp }));

    installLoader(async (opts: unknown) => {
      const { onEntrypointLoaded } = opts as {
        onEntrypointLoaded: (init: unknown) => Promise<void>;
      };
      await onEntrypointLoaded({ initializeEngine });
    });

    await loadFlutterApp('/cdn/', 'rev', [{}], onProgress);

    const messages = onProgress.mock.calls.map((c) => c[1] as string);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Initializing Flutter engine',
        'Starting application',
      ]),
    );
    expect(initializeEngine).toHaveBeenCalledOnce();
    expect(runApp).toHaveBeenCalledOnce();
  });

  it('disables pointer events on <flutter-view> during init', async () => {
    const view = document.createElement('flutter-view');
    document.body.appendChild(view);

    const runApp = vi.fn(async () => undefined);
    const initializeEngine = vi.fn(async () => ({ runApp }));

    installLoader(async (opts: unknown) => {
      const { onEntrypointLoaded } = opts as {
        onEntrypointLoaded: (init: unknown) => Promise<void>;
      };
      await onEntrypointLoaded({ initializeEngine });
    });

    await loadFlutterApp('/cdn/', 'rev', [{}], vi.fn());
    expect((view as HTMLElement).style.pointerEvents).toBe('none');
    view.remove();
  });

  it('throws when _flutter.loader is not available', async () => {
    // Simulate bootstrap without the inlined flutter.js IIFE.
    delete (window as FlutterWindow)._flutter;

    await expect(
      loadFlutterApp('/cdn/', 'rev', [{}], vi.fn()),
    ).rejects.toThrow(/_flutter\.loader not available/);
  });
});
