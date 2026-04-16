import type { SWProgressMessage } from '../shared/types';

/**
 * Send a progress notification to all connected clients.
 */
export async function notifyClients(
  sw: ServiceWorkerGlobalScope,
  message: SWProgressMessage,
): Promise<void> {
  const clients = await sw.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const client of clients) {
    client.postMessage(message);
  }
}
