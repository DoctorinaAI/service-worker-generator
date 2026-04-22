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

    // If a newer worker is already in the `waiting` slot at bootstrap
    // time (installed by a prior tab/session that never accepted the
    // update), hand over control to it *before* Flutter fetches any
    // main.dart.wasm / main.dart.mjs. The old controller can otherwise
    // serve a stale-cached .wasm alongside a fresh-from-network .mjs
    // whenever its manifest is missing a file the new build adds —
    // which surfaces as `WebAssembly.instantiate(): Import #N "X"`.
    // This auto-handoff is scoped to bootstrap only: once the pipeline
    // proceeds and the app is running, further updates go through the
    // user-approval flow via `sw-update-available` / `applyUpdate`.
    if (await activateWaitingAtBootstrap(registration)) {
      return registration;
    }

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
 * Force-activate a pre-existing waiting worker during bootstrap.
 *
 * If a prior tab installed a newer SW but left it in `waiting` (because
 * the old controller kept serving that tab and `skipWaiting` was never
 * called), the new worker sits unactivated. On a fresh page load the old
 * worker still controls, and if its manifest is missing a file the new
 * build added, that file falls through the cache-first handler straight
 * to the network — producing stale-wasm + fresh-mjs mismatches and the
 * `WebAssembly.instantiate(): Import #N "X"` error from Flutter's wasm
 * loader.
 *
 * We only auto-activate at bootstrap time, when the app hasn't started
 * yet and swapping controllers is non-disruptive. Post-bootstrap updates
 * continue to use the user-approval flow (`sw-update-available` →
 * `applyUpdate`) so running apps are never yanked out from under the
 * user. Bounded by a timeout — if the controller handoff doesn't land,
 * we fall back to the existing `waitForActivation` path rather than hang.
 *
 * Returns true if the new worker took control.
 */
async function activateWaitingAtBootstrap(
  registration: ServiceWorkerRegistration,
): Promise<boolean> {
  const waiting = registration.waiting;
  if (!waiting) return false;

  logPhase('SW', 'Waiting worker present at bootstrap; activating');

  const controllerChanged = new Promise<'ok'>((resolve) => {
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => resolve('ok'),
      { once: true },
    );
  });
  const timedOut = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), SW_REGISTRATION_TIMEOUT_MS),
  );

  waiting.postMessage({ type: 'skipWaiting' });
  const outcome = await Promise.race([controllerChanged, timedOut]);

  if (outcome === 'timeout') {
    logPhase('SW', 'Waiting-worker handoff timed out, continuing with old');
    return false;
  }

  logPhase('SW', 'New worker took control during bootstrap');
  return true;
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
 * sessionStorage key marking that this tab already performed a one-shot
 * recovery reload for a foreign SW controller.
 */
const FOREIGN_RELOAD_KEY = 'sw-foreign-controller-reload';

/**
 * If the current page is controlled by a service worker whose script URL
 * doesn't match our expected SW, it's a stale/foreign controller (Flutter's
 * default `flutter_service_worker.js` left over from a prior deployment, an
 * older sw.js on a different path, etc.). Such controllers can serve a
 * mismatched mix of cached old files alongside fresh network fetches, which
 * manifests as `WebAssembly.instantiate(): Import #N "X": module is not an
 * object or function` when dart2wasm import conventions change between
 * builds.
 *
 * When detected, unregister foreign registrations and trigger exactly one
 * `location.reload()` per tab session so the reloaded page starts with no
 * controller and registers our SW cleanly. A sessionStorage flag guards
 * against reload loops if the recovery itself fails to dislodge the
 * controller.
 *
 * Returns `true` when a reload was scheduled — the caller MUST abort further
 * bootstrap work, since the page is about to navigate.
 */
export async function reloadIfForeignController(
  swFilename: string,
): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  const controller = navigator.serviceWorker.controller;
  if (!controller) return false;

  let expectedPath: string;
  try {
    expectedPath = new URL(swFilename, self.location.href).pathname;
  } catch {
    return false;
  }

  let ctrlPath: string;
  try {
    ctrlPath = new URL(controller.scriptURL).pathname;
  } catch {
    return false;
  }

  if (ctrlPath === expectedPath) return false;

  // One-shot guard: if we already reloaded once in this tab and the foreign
  // controller is still there, don't loop — let the error surface instead.
  try {
    if (sessionStorage.getItem(FOREIGN_RELOAD_KEY)) return false;
    sessionStorage.setItem(FOREIGN_RELOAD_KEY, '1');
  } catch {
    // sessionStorage may be blocked (strict privacy modes). Without a way
    // to guarantee a single reload, bail out to avoid the infinite-loop
    // risk entirely.
    return false;
  }

  logPhase(
    'SW',
    `Foreign controller ${ctrlPath} detected (expected ${expectedPath}); ` +
      'reloading once to recover',
  );

  // Surgical cleanup: unregister ONLY the registration whose active worker
  // is the current controller. Other registrations at unrelated scopes —
  // typically `firebase-messaging-sw.js` for push notifications, or any
  // other purpose-built SW — must stay intact, because unregistering them
  // would drop their push subscriptions and break functionality unrelated
  // to the caching layer we're trying to fix. The reload below is what
  // actually detaches the old controller from this page.
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const doomed = registrations.find(
      (reg) => reg.active?.scriptURL === controller.scriptURL,
    );
    if (doomed) {
      await doomed.unregister();
    }
  } catch {
    // Non-fatal — reload anyway.
  }

  self.location.reload();
  return true;
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
