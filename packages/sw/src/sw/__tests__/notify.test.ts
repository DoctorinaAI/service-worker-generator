/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { notifyClients } from '../notify';
import type { SWProgressMessage } from '../../shared/types';
import { createMockSwScope, createMockClient } from '../../__tests__/helpers';

const SAMPLE: SWProgressMessage = {
  type: 'sw-progress',
  timestamp: 1,
  resourcesSize: 1,
  resourcesCount: 1,
  resourceName: 'x',
  resourceUrl: 'x',
  resourceKey: 'x',
  resourceSize: 1,
  loaded: 1,
  status: 'completed',
};

describe('notifyClients', () => {
  it('posts the message to every matched client', async () => {
    const c1 = createMockClient('a');
    const c2 = createMockClient('b');
    const sw = createMockSwScope({ clients: [c1, c2] });

    await notifyClients(
      sw as unknown as ServiceWorkerGlobalScope,
      SAMPLE,
    );

    expect(c1.postMessage).toHaveBeenCalledWith(SAMPLE);
    expect(c2.postMessage).toHaveBeenCalledWith(SAMPLE);
  });

  it('requests only window clients and includes uncontrolled ones', async () => {
    const sw = createMockSwScope({ clients: [] });
    await notifyClients(sw as unknown as ServiceWorkerGlobalScope, SAMPLE);
    expect(sw.clients.matchAll).toHaveBeenCalledWith({
      type: 'window',
      includeUncontrolled: true,
    });
  });

  it('does nothing when there are no clients', async () => {
    const sw = createMockSwScope({ clients: [] });
    await expect(
      notifyClients(sw as unknown as ServiceWorkerGlobalScope, SAMPLE),
    ).resolves.toBeUndefined();
  });

  it('keeps posting to remaining clients if one throws (current behavior: surfaces)', async () => {
    // postMessage is synchronous; we record that notifyClients propagates
    // throws from the first client synchronously, so the second client is
    // skipped. This locks the current behavior for regression detection.
    const throwing = createMockClient('bad');
    throwing.postMessage = vi.fn(() => {
      throw new Error('client-gone');
    });
    const ok = createMockClient('good');
    const sw = createMockSwScope({ clients: [throwing, ok] });

    await expect(
      notifyClients(sw as unknown as ServiceWorkerGlobalScope, SAMPLE),
    ).rejects.toThrow('client-gone');
    expect(ok.postMessage).not.toHaveBeenCalled();
  });
});
