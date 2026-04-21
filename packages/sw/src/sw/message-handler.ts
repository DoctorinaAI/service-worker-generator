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
 */
export function createMessageHandler(
  version: string,
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
      case 'getVersion':
        try {
          const reply: {
            type: 'version';
            version: string;
            requestId?: string;
          } = { type: 'version', version };
          if (msg.requestId !== undefined) reply.requestId = msg.requestId;
          event.source?.postMessage(reply);
        } catch (error) {
          console.warn('[SW] Failed to reply with version:', error);
        }
        break;
    }
  };
}
