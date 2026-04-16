import { SW_REGISTRATION_TIMEOUT_MS } from '../shared/constants';
import { logPhase } from './console-logger';

/**
 * Register the service worker with timeout and fallback.
 * Returns true if SW was registered successfully.
 */
export async function registerServiceWorker(
  swFilename: string,
  swVersion: string,
): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    logPhase('SW', 'Service Workers not supported');
    return null;
  }

  // First, unregister any old Flutter service worker
  await unregisterFlutterSW();

  const swUrl = `${swFilename}?v=${swVersion}`;

  try {
    logPhase('SW', `Registering ${swUrl}`);

    const registration = await navigator.serviceWorker.register(swUrl);
    logPhase('SW', 'Registered successfully');

    // Wait for activation with timeout
    const activated = await waitForActivation(registration);
    if (activated) {
      logPhase('SW', 'Activated');
    } else {
      logPhase('SW', 'Activation timed out, continuing without SW');
    }

    return registration;
  } catch (error) {
    logPhase(
      'SW',
      `Registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Set up a message listener for SW progress notifications.
 * Returns a cleanup function.
 */
export function listenForSWMessages(
  callback: (data: unknown) => void,
): () => void {
  const handler = (event: MessageEvent) => {
    if (event.data?.type === 'sw-progress') {
      callback(event.data);
    }
  };

  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}

/**
 * Unregister any existing Flutter service worker.
 */
async function unregisterFlutterSW(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const reg of registrations) {
      if (
        reg.active?.scriptURL.includes('flutter_service_worker') ||
        reg.active?.scriptURL.includes('flutter_sw')
      ) {
        await reg.unregister();
        logPhase('SW', 'Unregistered old Flutter service worker');
      }
    }
  } catch {
    // Ignore — not critical
  }
}

/**
 * Wait for a service worker to activate, with timeout.
 */
async function waitForActivation(
  registration: ServiceWorkerRegistration,
): Promise<boolean> {
  const worker =
    registration.installing || registration.waiting || registration.active;

  if (!worker) return false;
  if (worker.state === 'activated') return true;

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, SW_REGISTRATION_TIMEOUT_MS);

    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') {
        clearTimeout(timeout);
        resolve(true);
      }
    });
  });
}
