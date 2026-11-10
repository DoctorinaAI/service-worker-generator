/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ResolvedConfig } from '../config';

const { runPipeline, installGlobalAPI, logVersionBanner } = vi.hoisted(() => ({
  runPipeline: vi.fn((_config: ResolvedConfig) => ({ marker: 'api' })),
  installGlobalAPI: vi.fn(),
  logVersionBanner: vi.fn(),
}));

vi.mock('../pipeline', () => ({ runPipeline }));
vi.mock('../api', () => ({ installGlobalAPI }));
vi.mock('../console-logger', () => ({ logVersionBanner }));

/** Evaluate the entry point afresh, as a page load does. */
async function loadEntry(): Promise<void> {
  vi.resetModules();
  await import('../index');
}

function setReadyState(state: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    get: () => state,
  });
}

describe('bootstrap entry point', () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__swBootstrapStarted;
    runPipeline.mockClear();
    installGlobalAPI.mockClear();
    logVersionBanner.mockClear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    delete (document as unknown as { readyState?: unknown }).readyState;
    document.body.innerHTML = '';
  });

  it('starts at once when the document has already been parsed', async () => {
    setReadyState('interactive');
    await loadEntry();
    expect(runPipeline).toHaveBeenCalledOnce();
    expect(logVersionBanner).toHaveBeenCalledOnce();
  });

  it('waits for DOMContentLoaded while the document is still loading, and starts once', async () => {
    setReadyState('loading');
    await loadEntry();
    expect(runPipeline).not.toHaveBeenCalled();

    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(runPipeline).toHaveBeenCalledOnce();
  });

  it('starts once when bootstrap.js is on the page twice', async () => {
    // Two pipelines meant two loading screens and two loader calls, and the
    // second `window.Bootstrap` replaced the first.
    setReadyState('interactive');
    await loadEntry();
    await loadEntry();
    expect(runPipeline).toHaveBeenCalledOnce();
    expect(installGlobalAPI).toHaveBeenCalledOnce();
  });

  it('falls back to the defaults for a data-config that is not an object', async () => {
    document.body.innerHTML = `<script data-sw-bootstrap data-config='null'></script>`;
    setReadyState('complete');
    await loadEntry();
    expect(runPipeline).toHaveBeenCalledOnce();
    expect(runPipeline.mock.calls[0]![0].ui.color).toBe('#25D366');
  });

  it('installs the globals for the API the pipeline returned, after starting it', async () => {
    // Dart may call window.updateLoadingProgress in the same microtask
    // chain, so the globals must exist before anything awaits.
    setReadyState('complete');
    await loadEntry();
    expect(installGlobalAPI).toHaveBeenCalledWith({ marker: 'api' });
    expect(runPipeline.mock.invocationCallOrder[0]).toBeLessThan(
      installGlobalAPI.mock.invocationCallOrder[0],
    );
  });

  it('applies the page data-config over the defaults', async () => {
    document.body.innerHTML =
      `<script data-sw-bootstrap data-config='{"title":"My App","theme":"dark"}'></script>`;
    setReadyState('complete');
    await loadEntry();
    const config = runPipeline.mock.calls[0]![0];
    expect(config.ui.title).toBe('My App');
    expect(config.ui.theme).toBe('dark');
    expect(config.ui.color).toBe('#25D366');
  });
});
