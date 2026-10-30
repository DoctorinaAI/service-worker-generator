/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createInstallHandler } from '../install-handler';
import { createProgressReporter } from '../progress';
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

  it('precaches Core + Required resources into the temp cache without auto-activating', async () => {
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

    const handler = createInstallHandler('app', 'v1', manifest, createProgressReporter('v1', manifest));
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    expect(event.waitUntil).toHaveBeenCalledOnce();
    await event._promise;

    const temp = mockCaches.peek('app-temp-v1');
    expect(temp).toBeDefined();
    expect(await temp!.match('main.dart.js')).toBeDefined();
    expect(await temp!.match('AssetManifest.json')).toBeDefined();
    expect(await temp!.match('logo.png')).toBeUndefined();

    expect(skipWaitingSpy).not.toHaveBeenCalled();
  });

  it('deletes the temp cache and rethrows when a Core precache fails', async () => {
    // 5xx is retried with backoff now; collapse the delays.
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);
    installMockFetch(async () => textResponse('down', 500));
    const manifest: ResourceManifest = {
      'main.dart.js': {
        name: 'main.dart.js',
        size: 100,
        hash: 'h-core',
        category: ResourceCategory.Core,
      },
    };

    const handler = createInstallHandler('app', 'v2', manifest, createProgressReporter('v2', manifest));
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);

    await expect(event._promise).rejects.toThrow(/Precache failed/);
    expect(mockCaches.peek('app-temp-v2')).toBeUndefined();
    expect(skipWaitingSpy).not.toHaveBeenCalled();
  });

  it('tolerates Required/Optional failures and still completes install without auto-activating', async () => {
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

    const handler = createInstallHandler('app', 'v3', manifest, createProgressReporter('v3', manifest));
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;

    const temp = mockCaches.peek('app-temp-v3');
    expect(temp).toBeDefined();
    expect(await temp!.match('good.js')).toBeDefined();
    expect(await temp!.match('bad.json')).toBeUndefined();
    expect(skipWaitingSpy).not.toHaveBeenCalled();
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

    const handler = createInstallHandler('app', 'v4', manifest, createProgressReporter('v4', manifest));
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
    const handler = createInstallHandler('myorg-app', 'build-42', {}, createProgressReporter('build-42', {}));
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;

    // Empty manifest means nothing gets fetched, but precacheResources
    // still opens the temp cache.
    expect(await mockCaches.keys()).toContain('myorg-app-temp-build-42');
  });
});

describe('install — orphaned temp caches', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installMockFetch(async () => textResponse('ok'));
  });

  afterEach(() => {
    delete (self as unknown as { registration?: unknown }).registration;
    vi.restoreAllMocks();
  });

  const worker = (v: string | null): { scriptURL: string } => ({
    scriptURL: v === null ? 'not a url' : `${self.location.origin}/sw.js?v=${v}`,
  });

  async function install(version: string): Promise<void> {
    const handler = createInstallHandler('app', version, {}, createProgressReporter(version, {}));
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;
  }

  it('removes temp caches of abandoned versions at the start of install', async () => {
    for (const name of [
      'app-temp-v1', // abandoned waiting worker of an older deploy
      'app-temp-v2', // active
      'app-temp-v3', // waiting
      'app-v2',
      'app-manifest',
      'app2-temp-v1',
    ]) {
      await mockCaches.open(name);
    }
    (self as unknown as { registration: unknown }).registration = {
      installing: worker('v4'),
      waiting: worker('v3'),
      active: worker('v2'),
    };
    await install('v4');
    expect((await mockCaches.keys()).sort()).toEqual(
      ['app-temp-v2', 'app-temp-v3', 'app-temp-v4', 'app-v2', 'app-manifest', 'app2-temp-v1'].sort(),
    );
  });

  it('keeps its own temp cache even without a registration', async () => {
    await mockCaches.open('app-temp-v1');
    await mockCaches.open('app-temp-v4');
    await install('v4');
    // `app-manifest` is opened first, as the claim on the prefix.
    expect((await mockCaches.keys()).sort()).toEqual(['app-manifest', 'app-temp-v4']);
  });

  it('opens the manifest cache before it creates its temp cache', async () => {
    // The manifest cache marks the prefix as in use: an app with prefix
    // `app` must see it in any listing that already has our temp cache.
    const opened: string[] = [];
    const origOpen = caches.open.bind(caches);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => {
      opened.push(name);
      return origOpen(name);
    });
    await install('v4');
    expect(opened[0]).toBe('app-manifest');
    expect(opened).toContain('app-temp-v4');
  });

  it('removes nothing while the waiting worker has no readable version', async () => {
    await mockCaches.open('app-temp-v1');
    (self as unknown as { registration: unknown }).registration = {
      installing: worker('v4'),
      waiting: worker(null),
      active: worker('v2'),
    };
    await install('v4');
    expect(await mockCaches.keys()).toContain('app-temp-v1');
  });

  it('an active worker without a readable version keeps nothing extra', async () => {
    await mockCaches.open('app-temp-v1');
    (self as unknown as { registration: unknown }).registration = {
      installing: worker('v4'),
      waiting: null,
      active: worker(null),
    };
    await install('v4');
    expect(await mockCaches.keys()).not.toContain('app-temp-v1');
  });

  it('still installs when the cleanup fails', async () => {
    const keys = vi.spyOn(mockCaches, 'keys').mockRejectedValueOnce(new Error('boom'));
    await install('v4');
    expect(keys).toHaveBeenCalled();
    expect(mockCaches.peek('app-temp-v4')).toBeDefined();
  });
});
