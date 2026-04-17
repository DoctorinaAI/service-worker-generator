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

function flushMicrotasks(rounds = 20): Promise<void> {
  return (async () => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  })();
}

/**
 * Patch document.head.appendChild so loading "flutter.js" resolves the
 * script's onload synchronously after the tag is added.
 */
function installScriptStub(onAppend?: (script: HTMLScriptElement) => void): void {
  const head = document.head;
  const original = head.appendChild.bind(head);
  (head as unknown as { appendChild: (n: Node) => Node }).appendChild = (
    node: Node,
  ): Node => {
    if (node instanceof HTMLScriptElement) {
      onAppend?.(node);
      queueMicrotask(() => node.onload?.(new Event('load')));
    }
    return original(node);
  };
}

describe('loadFlutterApp', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalAppendChild: typeof document.head.appendChild;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    originalAppendChild = document.head.appendChild;
  });

  afterEach(() => {
    document.head.appendChild = originalAppendChild;
    delete (window as FlutterWindow)._flutter;
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('seeds _flutter.buildConfig before loading flutter.js', async () => {
    installScriptStub(() => {
      // By the time flutter.js "loads", buildConfig should already exist.
      (window as FlutterWindow)._flutter!.loader = {
        load: vi.fn(async () => undefined),
      };
    });

    const builds: FlutterBuildEntry[] = [{ renderer: 'canvaskit' }];
    const promise = loadFlutterApp('/cdn/', 'rev', builds, vi.fn());
    await flushMicrotasks();
    await promise;

    expect((window as FlutterWindow)._flutter?.buildConfig).toEqual({
      engineRevision: 'rev',
      builds,
    });
  });

  it('calls flutter.loader.load with canvasKitBaseUrl that always ends in "/"', async () => {
    const loadSpy = vi.fn<(opts: unknown) => Promise<void>>(
      async () => undefined,
    );
    installScriptStub(() => {
      (window as FlutterWindow)._flutter!.loader = { load: loadSpy };
    });

    await loadFlutterApp('/cdn/base', 'rev', [{}], vi.fn());

    expect(loadSpy).toHaveBeenCalledOnce();
    const callArg = loadSpy.mock.calls[0][0] as {
      config: { canvasKitBaseUrl: string };
    };
    expect(callArg.config.canvasKitBaseUrl).toBe('/cdn/base/');
  });

  it('does not double-append "/" when base already ends with "/"', async () => {
    const loadSpy = vi.fn<(opts: unknown) => Promise<void>>(
      async () => undefined,
    );
    installScriptStub(() => {
      (window as FlutterWindow)._flutter!.loader = { load: loadSpy };
    });

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

    installScriptStub(() => {
      (window as FlutterWindow)._flutter!.loader = {
        load: async (opts: unknown) => {
          const { onEntrypointLoaded } = opts as {
            onEntrypointLoaded: (init: unknown) => Promise<void>;
          };
          await onEntrypointLoaded({ initializeEngine });
        },
      };
    });

    await loadFlutterApp('/cdn/', 'rev', [{}], onProgress);

    // First call: entry loaded, second call: engine initialized.
    const messages = onProgress.mock.calls.map((c) => c[1] as string);
    expect(messages).toEqual(
      expect.arrayContaining(['Initializing Flutter engine', 'Starting application']),
    );
    expect(initializeEngine).toHaveBeenCalledOnce();
    expect(runApp).toHaveBeenCalledOnce();
  });

  it('disables pointer events on <flutter-view> during init', async () => {
    const view = document.createElement('flutter-view');
    document.body.appendChild(view);

    const runApp = vi.fn(async () => undefined);
    const initializeEngine = vi.fn(async () => ({ runApp }));

    installScriptStub(() => {
      (window as FlutterWindow)._flutter!.loader = {
        load: async (opts: unknown) => {
          const { onEntrypointLoaded } = opts as {
            onEntrypointLoaded: (init: unknown) => Promise<void>;
          };
          await onEntrypointLoaded({ initializeEngine });
        },
      };
    });

    await loadFlutterApp('/cdn/', 'rev', [{}], vi.fn());
    expect((view as HTMLElement).style.pointerEvents).toBe('none');
    view.remove();
  });

  it('throws when flutter.js loads but _flutter.loader is missing', async () => {
    installScriptStub(() => {
      // Intentionally don't set up loader.
    });
    await expect(
      loadFlutterApp('/cdn/', 'rev', [{}], vi.fn()),
    ).rejects.toThrow(/_flutter\.loader not available/);
  });

  it('rejects when flutter.js fails to load', async () => {
    const head = document.head;
    const original = head.appendChild.bind(head);
    (head as unknown as { appendChild: (n: Node) => Node }).appendChild = (
      node: Node,
    ): Node => {
      if (node instanceof HTMLScriptElement) {
        queueMicrotask(() => node.onerror?.(new Event('error')));
      }
      return original(node);
    };

    await expect(
      loadFlutterApp('/cdn/', 'rev', [{}], vi.fn()),
    ).rejects.toThrow(/Failed to load script/);
  });
});
