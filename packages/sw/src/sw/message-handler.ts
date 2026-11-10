import { log } from '../shared/logger';
import type { SWStatusMessage } from '../shared/types';
import { collectStatus } from './lifecycle';

declare const self: ServiceWorkerGlobalScope;

interface ClientMessage {
  type?: string;
  requestId?: string;
}

/**
 * Handle messages from clients.
 *
 * Accepts both legacy string-form commands (`'skipWaiting'`) and the
 * structured `{ type, requestId? }` form. When a `requestId` is supplied
 * it is echoed back on the response so clients can correlate replies.
 * `getVersion` also reports [engineRevision] when the build has one, and
 * `getStatus` answers with this worker's caches, the browser's storage
 * estimate and the last lifecycle failure (audit #30, item 6.1).
 */
export function createMessageHandler(
  version: string,
  cachePrefix: string,
  engineRevision?: string,
): (event: ExtendableMessageEvent) => void {
  return (event: ExtendableMessageEvent) => {
    const { data } = event;

    if (typeof data === 'string') {
      if (data === 'skipWaiting') self.skipWaiting();
      return;
    }

    if (typeof data !== 'object' || data === null) return;

    const msg = data as ClientMessage;
    switch (msg.type) {
      case 'skipWaiting':
        self.skipWaiting();
        break;
      case 'getStatus':
        // What this worker has and the last thing that went wrong in it.
        // Answered asynchronously, so the reply is kept alive by the event.
        event.waitUntil(
          (async () => {
            try {
              const reply: SWStatusMessage = {
                type: 'status',
                ...(await collectStatus(version, cachePrefix, engineRevision)),
                ...(msg.requestId !== undefined
                  ? { requestId: msg.requestId }
                  : {}),
              };
              event.source?.postMessage(reply);
            } catch (error) {
              log.warn('[SW] Failed to reply with status:', error);
            }
          })(),
        );
        break;
      case 'getVersion':
        try {
          const reply: {
            type: 'version';
            version: string;
            engineRevision?: string;
            requestId?: string;
          } = { type: 'version', version };
          if (engineRevision) reply.engineRevision = engineRevision;
          if (msg.requestId !== undefined) reply.requestId = msg.requestId;
          event.source?.postMessage(reply);
        } catch (error) {
          log.warn('[SW] Failed to reply with version:', error);
        }
        break;
    }
  };
}
