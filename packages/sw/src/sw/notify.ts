import type { SWLifecycleMessage, SWProgressMessage } from '../shared/types';
import { log } from '../shared/logger';

/**
 * Send a notification to all connected clients.
 *
 * A single `postMessage` failure (e.g. a client whose channel just closed)
 * must not abort the loop — otherwise one dead client starves all others
 * of progress updates during install.
 */
export async function notifyClients(
  sw: ServiceWorkerGlobalScope,
  message: SWProgressMessage | SWLifecycleMessage,
): Promise<void> {
  const clients = await sw.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const client of clients) {
    try {
      client.postMessage(message);
    } catch (error) {
      log.warn('[SW] postMessage failed for client:', error);
    }
  }
}
