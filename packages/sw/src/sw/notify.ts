import type { SWProgressMessage } from '../shared/types';

/**
 * Send a progress notification to all connected clients.
 *
 * A single `postMessage` failure (e.g. a client whose channel just closed)
 * must not abort the loop — otherwise one dead client starves all others
 * of progress updates during install.
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
    try {
      client.postMessage(message);
    } catch (error) {
      console.warn('[SW] postMessage failed for client:', error);
    }
  }
}
