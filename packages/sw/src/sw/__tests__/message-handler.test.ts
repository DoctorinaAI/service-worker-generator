/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMessageHandler } from '../message-handler';

interface FakeMessageEvent {
  data: unknown;
  source: { postMessage: ReturnType<typeof vi.fn> } | null;
}

function makeEvent(data: unknown, hasSource = true): FakeMessageEvent {
  return {
    data,
    source: hasSource ? { postMessage: vi.fn() } : null,
  };
}

describe('createMessageHandler', () => {
  let skipWaitingSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    skipWaitingSpy = vi.fn(async () => undefined);
    (self as unknown as { skipWaiting: () => Promise<void> }).skipWaiting =
      skipWaitingSpy;
  });

  afterEach(() => {
    delete (self as unknown as { skipWaiting?: unknown }).skipWaiting;
    vi.restoreAllMocks();
  });

  it('calls self.skipWaiting when receiving the "skipWaiting" string message', () => {
    const handler = createMessageHandler('v1');
    const event = makeEvent('skipWaiting');
    handler(event as unknown as ExtendableMessageEvent);
    expect(skipWaitingSpy).toHaveBeenCalledOnce();
  });

  it('ignores unknown string messages without throwing', () => {
    const handler = createMessageHandler('v1');
    const event = makeEvent('bogus');
    expect(() => handler(event as unknown as ExtendableMessageEvent)).not.toThrow();
    expect(skipWaitingSpy).not.toHaveBeenCalled();
  });

  it('responds to "getVersion" by posting the current version back to the source', () => {
    const handler = createMessageHandler('build-123');
    const event = makeEvent({ type: 'getVersion' });
    handler(event as unknown as ExtendableMessageEvent);
    expect(event.source!.postMessage).toHaveBeenCalledWith({
      type: 'version',
      version: 'build-123',
    });
  });

  it('silently ignores getVersion when there is no source', () => {
    const handler = createMessageHandler('v1');
    const event = makeEvent({ type: 'getVersion' }, false);
    expect(() => handler(event as unknown as ExtendableMessageEvent)).not.toThrow();
  });

  it('ignores objects without a recognized type', () => {
    const handler = createMessageHandler('v1');
    const event = makeEvent({ type: 'other' });
    handler(event as unknown as ExtendableMessageEvent);
    expect(event.source!.postMessage).not.toHaveBeenCalled();
    expect(skipWaitingSpy).not.toHaveBeenCalled();
  });

  it('ignores null/undefined data', () => {
    const handler = createMessageHandler('v1');
    handler(makeEvent(null) as unknown as ExtendableMessageEvent);
    handler(makeEvent(undefined) as unknown as ExtendableMessageEvent);
    expect(skipWaitingSpy).not.toHaveBeenCalled();
  });
});
