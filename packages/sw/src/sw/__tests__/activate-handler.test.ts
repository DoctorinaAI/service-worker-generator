/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createActivateHandler } from '../activate-handler';
import type { ResourceManifest } from '../../shared/types';
import { ResourceCategory } from '../../shared/types';
import {
  installMockCaches,
  textResponse,
  type MockCacheStorage,
} from '../../__tests__/helpers';

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

describe('createActivateHandler', () => {
  let mockCaches: MockCacheStorage;
  let claimSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCaches = installMockCaches();
    claimSpy = vi.fn(async () => undefined);
    (self as unknown as { clients: unknown }).clients = { claim: claimSpy };
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete (self as unknown as { clients?: unknown }).clients;
    delete (self as unknown as { registration?: unknown }).registration;
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('performs swap, cleanup, and clients.claim', async () => {
    // Pre-populate temp cache from a prior install
    const temp = await mockCaches.open('app-temp-v2');
    await temp.put(new Request('main.dart.js'), textResponse('new-core'));
    // Old cache from a prior version
    await mockCaches.open('app-v1');
    // No-op navigation preload
    (self as unknown as { registration: unknown }).registration = {};

    const manifest: ResourceManifest = {
      'main.dart.js': {
        name: 'main.dart.js',
        size: 1,
        hash: 'h',
        category: ResourceCategory.Core,
      },
    };

    const handler = createActivateHandler('app', 'v2', manifest);
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;

    const content = mockCaches.peek('app-v2');
    expect(content).toBeDefined();
    expect(await content!.match('main.dart.js')).toBeDefined();

    const names = await mockCaches.keys();
    expect(names).not.toContain('app-v1');
    expect(names).not.toContain('app-temp-v2');
    expect(names).toContain('app-v2');

    expect(claimSpy).toHaveBeenCalledOnce();
  });

  it('enables navigation preload when supported', async () => {
    await mockCaches.open('app-temp-v1');
    const enableSpy = vi.fn(async () => undefined);
    (self as unknown as { registration: unknown }).registration = {
      navigationPreload: { enable: enableSpy },
    };

    const handler = createActivateHandler('app', 'v1', {});
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;

    expect(enableSpy).toHaveBeenCalledOnce();
  });

  it('skips navigation preload when unavailable', async () => {
    await mockCaches.open('app-temp-v1');
    (self as unknown as { registration: unknown }).registration = {
      navigationPreload: undefined,
    };

    const handler = createActivateHandler('app', 'v1', {});
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    // Should not throw
    await event._promise;
    expect(claimSpy).toHaveBeenCalledOnce();
  });

  it('always calls clients.claim even when swap throws', async () => {
    (self as unknown as { registration: unknown }).registration = {};
    // Force swapCaches to fail by making `caches.keys()` throw in a way
    // the activate-handler's catch block handles (it calls caches.delete).
    // Easier: just corrupt caches storage after construction — swap will
    // still run but the catch path clears caches and clients.claim runs.
    const handler = createActivateHandler('app', 'v1', {});
    const origOpen = caches.open.bind(caches);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => {
      if (name === 'app-temp-v1') throw new Error('cache fault');
      return origOpen(name);
    });

    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;

    expect(claimSpy).toHaveBeenCalledOnce();
  });

  it('wipes app-prefixed caches on error', async () => {
    (self as unknown as { registration: unknown }).registration = {};
    await mockCaches.open('app-v1');
    await mockCaches.open('app-v2');
    await mockCaches.open('other');

    const origOpen = caches.open.bind(caches);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => {
      if (name.startsWith('app-temp')) throw new Error('swap fault');
      return origOpen(name);
    });

    const handler = createActivateHandler('app', 'v3', {});
    const event = makeEvent();
    handler(event as unknown as ExtendableEvent);
    await event._promise;

    const remaining = await mockCaches.keys();
    expect(remaining.some((n) => n.startsWith('app-'))).toBe(false);
    expect(remaining).toContain('other');
  });
});
