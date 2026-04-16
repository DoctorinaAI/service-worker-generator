declare const self: ServiceWorkerGlobalScope;

/**
 * Handle messages from clients.
 */
export function createMessageHandler(
  version: string,
): (event: ExtendableMessageEvent) => void {
  return (event: ExtendableMessageEvent) => {
    const { data } = event;

    if (typeof data === 'string') {
      switch (data) {
        case 'skipWaiting':
          self.skipWaiting();
          break;
      }
      return;
    }

    if (data?.type === 'getVersion') {
      event.source?.postMessage({
        type: 'version',
        version,
      });
    }
  };
}
