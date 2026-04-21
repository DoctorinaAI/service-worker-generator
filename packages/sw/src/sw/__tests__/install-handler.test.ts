/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createInstallHandler } from '../install-handler';
import type { ResourceManifest } from '../../shared/types';
import { ResourceCategory } from '../../shared/types';
import {
  installMockCaches,
  installMockFetch,
  textResponse,
  type MockCacheStorage,
} from '../../__tests__/helpers';

vi.mock('../notify', () => ({
  notifyClients: vi.fn(async () => undefined),
}));

interface FakeExtendableEvent {
  _promise?: Promise<unknown>;
  waitUntil: ReturnType<typeof vi.fn>;
}

function makeEvent(): FakeExtendableEvent {
  const event: FakeExtendableEvent = {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      event._promise = p;
    }),
  };
  return event;
}

describe('createInstallHandler', () => {
  let mockCaches: MockCacheStorage;
  let skipWaitingSpy: Mock<() => Promise<void>>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCaches = installMockCaches();
    skipWaitingSpy = vi.fn(async () => undefined);
    // Install-handler reads `self.skipWaiting`. In jsdom, self === window.
    (self as unknown as { skipWaiting: () => Promise<void> }).skipWaiting =
      skipWaitingSpy;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete (self as unknown as { skipWaiting?: unknown }).skipWaiting;
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('precaches Core + Required resources into the temp cache and skipWaiting', async () => {
    installMockFetch(async (req) => textResponse(`body:${req.url}`));
    const manifest: ResourceManifest = {
      'main.dart.js': {
        name: 'main.dart.js',
        size: 100,
        hash: 'h-core',
        category: ResourceCategory.Core,
      },
      'AssetManifest.json': {
        name: 'AssetManifest.json',
        size: 50,
        hash: 'h-req',
        category: ResourceCategory.Required,
      },
      'logo.png': {
        name: 'logo.png',
        size: 30,
        hash: 'h-opt',
        category: ResourceCategory.Optional,
      },
    };

    const handler = createInstallHandler('app', 'v1', manifest, 150, 2);
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    expect(event.waitUntil).toHaveBeenCalledOnce();
    await event._promise;

    const temp = mockCaches.peek('app-temp-v1');
    expect(temp).toBeDefined();
    expect(await temp!.match('main.dart.js')).toBeDefined();
    expect(await temp!.match('AssetManifest.json')).toBeDefined();
    expect(await temp!.match('logo.png')).toBeUndefined();

    expect(skipWaitingSpy).toHaveBeenCalledOnce();
  });

  it('deletes the temp cache and rethrows when a Core precache fails', async () => {
    installMockFetch(async () => textResponse('down', 500));
    const manifest: ResourceManifest = {
      'main.dart.js': {
        name: 'main.dart.js',
        size: 100,
        hash: 'h-core',
        category: ResourceCategory.Core,
      },
    };

    const handler = createInstallHandler('app', 'v2', manifest, 100, 1);
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);

    await expect(event._promise).rejects.toThrow(/Precache failed/);
    expect(mockCaches.peek('app-temp-v2')).toBeUndefined();
    expect(skipWaitingSpy).not.toHaveBeenCalled();
  });

  it('tolerates Required/Optional failures and still completes install', async () => {
    // Collapse retry backoff to zero so the Required failure path is fast.
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);

    installMockFetch(async (req) => {
      if (req.url.includes('bad.json')) throw new Error('offline');
      return textResponse('ok');
    });
    const manifest: ResourceManifest = {
      'good.js': {
        name: 'good.js',
        size: 10,
        hash: 'h-g',
        category: ResourceCategory.Core,
      },
      'bad.json': {
        name: 'bad.json',
        size: 20,
        hash: 'h-b',
        category: ResourceCategory.Required,
      },
    };

    const handler = createInstallHandler('app', 'v3', manifest, 30, 2);
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;

    const temp = mockCaches.peek('app-temp-v3');
    expect(temp).toBeDefined();
    expect(await temp!.match('good.js')).toBeDefined();
    expect(await temp!.match('bad.json')).toBeUndefined();
    expect(skipWaitingSpy).toHaveBeenCalledOnce();
  });

  it('emits a progress notification through notifyClients', async () => {
    const notifyMod = (await import('../notify')) as unknown as {
      notifyClients: ReturnType<typeof vi.fn>;
    };
    notifyMod.notifyClients.mockClear();

    installMockFetch(async () => textResponse('ok'));
    const manifest: ResourceManifest = {
      'a.js': {
        name: 'a.js',
        size: 10,
        hash: 'h-a',
        category: ResourceCategory.Core,
      },
    };

    const handler = createInstallHandler('app', 'v4', manifest, 10, 1);
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;

    expect(notifyMod.notifyClients).toHaveBeenCalled();
    // Initial 'loading' + per-file 'completed' callback
    const calls = notifyMod.notifyClients.mock.calls.map(
      (c) => (c[1] as { status: string }).status,
    );
    expect(calls).toContain('loading');
    expect(calls).toContain('completed');
  });

  it('forwards the exact cachePrefix and version into the temp cache name', async () => {
    installMockFetch(async () => textResponse('ok'));
    const handler = createInstallHandler('myorg-app', 'build-42', {}, 0, 0);
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;

    // Empty manifest means nothing gets fetched, but precacheResources
    // still opens the temp cache.
    expect(await mockCaches.keys()).toContain('myorg-app-temp-build-42');
  });
});
