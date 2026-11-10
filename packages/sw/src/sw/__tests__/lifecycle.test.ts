/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectStatus, reportLifecycle, resetLastError } from '../lifecycle';
import { notifyClients } from '../notify';
import { createMessageHandler } from '../message-handler';
import type { SWLifecycleMessage, SWStatusMessage } from '../../shared/types';
import { installMockCaches, textResponse, type MockCacheStorage } from '../../__tests__/helpers';

vi.mock('../notify', () => ({
  notifyClients: vi.fn(async () => undefined),
}));

const mockedNotify = vi.mocked(notifyClients);

/**
 * Audit #30, item 6.1: install failures, a failed swap, dropped caches and
 * quota errors were logged inside the worker and nowhere else. A page had
 * no way to know its caching layer had given up, and neither had whatever
 * collects errors for the app.
 */
describe('reportLifecycle', () => {
  beforeEach(() => {
    resetLastError();
    mockedNotify.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetLastError();
    vi.restoreAllMocks();
  });

  const sent = (): SWLifecycleMessage =>
    mockedNotify.mock.calls[0]![1] as SWLifecycleMessage;

  it('broadcasts the phase, the status and the reason', async () => {
    await reportLifecycle('v1', 'install', 'failed', new Error('main.dart.js 500'));

    expect(mockedNotify).toHaveBeenCalledOnce();
    expect(sent()).toMatchObject({
      type: 'sw-lifecycle',
      swVersion: 'v1',
      phase: 'install',
      status: 'failed',
      reason: 'main.dart.js 500',
    });
  });

  it('tells a quota failure apart', async () => {
    await reportLifecycle(
      'v1',
      'activate',
      'failed',
      new DOMException('full', 'QuotaExceededError'),
    );
    expect(sent().isQuota).toBe(true);
  });

  it('says nothing about a quota when it was something else', async () => {
    await reportLifecycle('v1', 'cache', 'failed', new TypeError('broken'));
    expect(sent().isQuota).toBeUndefined();
  });

  it('carries no reason for a success', async () => {
    await reportLifecycle('v1', 'install', 'completed');
    expect(sent()).toMatchObject({ status: 'completed' });
    expect(sent().reason).toBeUndefined();
  });

  it('never throws, so it cannot replace the failure it reports', async () => {
    mockedNotify.mockRejectedValueOnce(new Error('no clients'));
    await expect(
      reportLifecycle('v1', 'install', 'failed', new Error('x')),
    ).resolves.toBeUndefined();
  });
});

describe('collectStatus', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(async () => {
    resetLastError();
    mockCaches = installMockCaches();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const content = await mockCaches.open('app-v1');
    await content.put(new Request('main.dart.js'), textResponse('code'));
    await content.put(new Request('index.html'), textResponse('<html>'));
    await mockCaches.open('app-manifest');
    // Another app on the same origin, which is none of our business.
    await mockCaches.open('other-app-v1');
  });

  afterEach(() => {
    resetLastError();
    vi.restoreAllMocks();
  });

  it('reports this app’s caches with their sizes', async () => {
    const status = await collectStatus('v1', 'app');

    expect(status.swVersion).toBe('v1');
    expect(status.caches).toEqual({ 'app-v1': 2, 'app-manifest': 0 });
  });

  it('includes the engine revision when the build has one', async () => {
    expect((await collectStatus('v1', 'app', 'rev-abc')).engineRevision).toBe(
      'rev-abc',
    );
    expect((await collectStatus('v1', 'app')).engineRevision).toBeUndefined();
  });

  it('includes the storage estimate when the browser answers', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ usage: 1234, quota: 5678 }) },
    });
    expect((await collectStatus('v1', 'app')).storage).toEqual({
      usage: 1234,
      quota: 5678,
    });
    delete (navigator as unknown as { storage?: unknown }).storage;
  });

  it('remembers the last failure for a page that loaded after it', async () => {
    // The broadcast happened before this page existed; the answer to
    // `getStatus` is the only way it can learn about it.
    await reportLifecycle('v1', 'install', 'failed', new Error('500'));
    const status = await collectStatus('v1', 'app');

    expect(status.lastError).toEqual({
      phase: 'install',
      reason: '500',
      isQuota: false,
    });
  });

  it('survives a CacheStorage it cannot read', async () => {
    vi.spyOn(mockCaches, 'keys').mockRejectedValue(new Error('blocked'));
    const status = await collectStatus('v1', 'app');
    expect(status.caches).toEqual({});
    expect(status.swVersion).toBe('v1');
  });
});

describe('getStatus message', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(async () => {
    resetLastError();
    mockCaches = installMockCaches();
    await mockCaches.open('app-v2');
  });

  afterEach(() => {
    resetLastError();
    vi.restoreAllMocks();
  });

  function makeEvent(data: unknown): {
    data: unknown;
    source: { postMessage: ReturnType<typeof vi.fn> };
    waitUntil: ReturnType<typeof vi.fn>;
    _work: Promise<unknown>[];
  } {
    const work: Promise<unknown>[] = [];
    return {
      data,
      source: { postMessage: vi.fn() },
      waitUntil: vi.fn((p: Promise<unknown>) => work.push(p)),
      _work: work,
    };
  }

  it('answers with the status and echoes the request id', async () => {
    const handler = createMessageHandler('v2', 'app', 'rev');
    const event = makeEvent({ type: 'getStatus', requestId: 'r-1' });
    handler(event as unknown as ExtendableMessageEvent);
    await Promise.all(event._work);

    expect(event.source.postMessage).toHaveBeenCalledOnce();
    const reply = event.source.postMessage.mock.calls[0]![0] as SWStatusMessage;
    expect(reply.type).toBe('status');
    expect(reply.requestId).toBe('r-1');
    expect(reply.swVersion).toBe('v2');
    expect(reply.engineRevision).toBe('rev');
    expect(reply.caches).toEqual({ 'app-v2': 0 });
  });

  it('answers without a request id when the client sent none', async () => {
    const handler = createMessageHandler('v2', 'app');
    const event = makeEvent({ type: 'getStatus' });
    handler(event as unknown as ExtendableMessageEvent);
    await Promise.all(event._work);

    const reply = event.source.postMessage.mock.calls[0]![0] as SWStatusMessage;
    expect(reply.requestId).toBeUndefined();
  });
});
