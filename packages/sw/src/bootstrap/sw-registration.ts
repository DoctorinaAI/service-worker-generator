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

    // updateViaCache: 'none' stops the browser from reusing a stale sw.js
    // (up to 24h by default), so freshly deployed SWs propagate immediately.
    const registration = await navigator.serviceWorker.register(swUrl, {
      updateViaCache: 'none',
    });
    logPhase('SW', 'Registered successfully');

    wireUpdateDetection(registration);

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
 * Dispatch a `sw-update-available` CustomEvent on `window` when a new SW
 * finishes installing while an older controller is still active. Consumers
 * can listen for this to show an "update available, reload?" UI.
 */
function wireUpdateDetection(registration: ServiceWorkerRegistration): void {
  const announce = (worker: ServiceWorker): void => {
    const onStateChange = (): void => {
      if (
        worker.state === 'installed' &&
        navigator.serviceWorker.controller !== null
      ) {
        logPhase('SW', 'Update available (new version installed)');
        window.dispatchEvent(
          new CustomEvent('sw-update-available', { detail: { registration } }),
        );
      }
    };
    worker.addEventListener('statechange', onStateChange);
  };

  if (registration.installing) announce(registration.installing);
  registration.addEventListener('updatefound', () => {
    if (registration.installing) announce(registration.installing);
  });
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
 * Activate a freshly-installed but waiting service worker.
 *
 * Sends `skipWaiting` to the registration's waiting worker, waits for the
 * browser to swap controllers, then resolves. Callers can then trigger a
 * page reload to pick up the new resources. Resolves to `false` when no
 * waiting worker is available or SW is unsupported.
 */
export async function activateWaitingSW(
  registration: ServiceWorkerRegistration,
): Promise<boolean> {
  const waiting = registration.waiting;
  if (!waiting) return false;

  const controllerChanged = new Promise<void>((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
      once: true,
    });
  });

  waiting.postMessage({ type: 'skipWaiting' });
  await controllerChanged;
  return true;
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
