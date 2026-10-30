import {
  RESET_TIMEOUT_MS,
  SW_BOOTSTRAP_TIMEOUT_MS,
  SW_ENGINE_QUERY_TIMEOUT_MS,
  SW_HANDOFF_TIMEOUT_MS,
  SW_REGISTRATION_TIMEOUT_MS,
  SW_UPDATE_INSTALL_TIMEOUT_MS,
} from '../shared/constants';
import { withTimeout } from '../shared/utils';
import { logPhase } from './console-logger';

/** Sentinel distinguishing "the budget ran out" from a null registration. */
const TIMED_OUT = Symbol('sw-registration-timeout');

/**
 * Register the service worker, giving up on it if it does not settle.
 *
 * Everything inside runs on the scope's service worker job queue, and that
 * queue is only as live as the jobs already on it: an install that never
 * settles — a precache body that stalled, say — leaves `register()`,
 * `unregister()` and `getRegistrations()` pending forever, for every later
 * page load on the origin, until the browser times the install out minutes
 * later. Without a cap the pipeline waits on that queue and the app never
 * boots at all, which is a far worse outcome than booting uncached.
 *
 * The abandoned promise is deliberately left running: when the browser does
 * free the queue, the registration completes and the worker installs in the
 * background, ready for the next load.
 *
 * Returns the registration, or `null` when the service worker is
 * unsupported, failed, or did not settle in time.
 */
export async function registerServiceWorker(
  swFilename: string,
  swVersion: string,
): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    logPhase('SW', 'Service Workers not supported');
    return null;
  }

  const outcome = await withTimeout(
    registerAndActivate(swFilename, swVersion),
    SW_BOOTSTRAP_TIMEOUT_MS,
    TIMED_OUT,
  );

  if (outcome === TIMED_OUT) {
    logPhase(
      'SW',
      `Registration did not settle in ${SW_BOOTSTRAP_TIMEOUT_MS}ms ` +
        '(service worker job queue is likely blocked); continuing without SW',
    );
    return null;
  }

  return outcome;
}

/**
 * The registration flow proper, unbounded — see `registerServiceWorker` for
 * the deadline that contains it.
 */
async function registerAndActivate(
  swFilename: string,
  swVersion: string,
): Promise<ServiceWorkerRegistration | null> {
  // First, unregister any old Flutter service worker
  await unregisterFlutterSW();

  // Encoded, so a `--version` such as `1.0.0+3` reads back unchanged in the
  // worker's `searchParams.get('v')`, where `+` would otherwise be a space.
  const swUrl = `${swFilename}?v=${encodeURIComponent(swVersion)}`;

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

    // A page that already has a controller does not wait here. A newer
    // worker installing or waiting beside it cannot activate while this
    // page is open, so waiting would only spend the full timeout and then
    // boot with the current controller anyway. Whether this load must
    // switch to the new worker first is `settleUpdateAtBootstrap`'s call.
    const pending = registration.installing ?? registration.waiting;
    if (pending && navigator.serviceWorker.controller) {
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
 * user.
 *
 * The handover can lose a race it cannot see. Activation stops the old
 * worker, and a request this page makes at that moment (the browser's
 * favicon fetch, a logo, the web manifest) is dispatched to the old worker
 * all the same, which restarts it. Chromium then keeps the new worker
 * waiting for as long as this page stays open; sending `skipWaiting` again
 * does not help. A handover that works lands in milliseconds, so it is
 * bounded by `SW_HANDOFF_TIMEOUT_MS`, and the caller carries on as if
 * there had been no waiting worker: a controlled page boots with its
 * current controller (or reloads once, on an engine change), and a first
 * visit falls back to `waitForActivation`.
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
    setTimeout(() => resolve('timeout'), SW_HANDOFF_TIMEOUT_MS),
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

/** Session flag: this tab already reloaded to reach a new engine. */
const UPDATE_RELOAD_KEY = 'sw-engine-update-reload';

/**
 * Make the first load after a deploy run on one build, when the Flutter
 * engine changed.
 *
 * Until a new worker takes over, the previous one controls the page and
 * serves the previous build's `main.dart.*` from its cache, while
 * `index.html` and this `bootstrap.js` are already the new build's — and
 * this bootstrap loads CanvasKit or skwasm for the new engine revision.
 * On the same engine that mix runs (flutter.js and the engine only change
 * with the Flutter SDK), so the page boots with its controller at once and
 * the new worker takes over on the next load. On a different engine it
 * fails in the engine itself (`WebAssembly.instantiate(): Import #N`), so
 * this waits for the new worker to install, hands control to it before
 * any app file is requested, and reloads once if the handover is lost.
 *
 * A controller from a release that predates `engineRevision` in its
 * `getVersion` reply counts as a different engine: the first load after
 * upgrading to this release waits once, which is safe either way.
 *
 * Returns `true` when the page is reloading and the pipeline must stop.
 */
export async function settleUpdateAtBootstrap(
  registration: ServiceWorkerRegistration,
  engineRevision: string,
): Promise<boolean> {
  const controller = navigator.serviceWorker?.controller;
  const pending = registration.installing ?? registration.waiting;
  if (!controller || !pending) {
    clearUpdateReloadFlag();
    return false;
  }
  // A worker already waiting when bootstrap started has had its handover
  // attempt in `registerAndActivate`; trying again would only repeat it.
  const handoverTried = pending === registration.waiting;

  const controllerEngine = await queryControllerEngine(controller);
  if (engineRevision && controllerEngine === engineRevision) {
    logPhase(
      'SW',
      'Newer worker pending on the same engine; continuing with the current one until reload',
    );
    return false;
  }

  logPhase(
    'SW',
    controllerEngine
      ? `Engine changed (${controllerEngine.slice(0, 10)} → ${engineRevision.slice(0, 10)}); switching to the new worker first`
      : 'Engine of the current worker is unknown; switching to the new worker first',
  );

  if (!(await waitForInstalled(pending, SW_UPDATE_INSTALL_TIMEOUT_MS))) {
    logPhase('SW', 'New worker did not install; continuing with the current one');
    return false;
  }
  if (!handoverTried && (await activateWaitingAtBootstrap(registration))) {
    clearUpdateReloadFlag();
    return false;
  }
  // Another tab may have handed over meanwhile, or the `controllerchange`
  // may have landed just after the handover timed out: the page is then
  // already on the new worker, and a reload would buy nothing.
  if (navigator.serviceWorker.controller !== controller) {
    logPhase('SW', 'New worker took control during bootstrap');
    clearUpdateReloadFlag();
    return false;
  }

  // The handover lost a race with a request this page made, and the new
  // worker stays waiting while the page is open. Nothing of the app has
  // loaded yet, so a reload is cheap; once is enough to avoid a loop.
  try {
    if (sessionStorage.getItem(UPDATE_RELOAD_KEY)) {
      logPhase('SW', 'Handover to the new worker failed again; continuing with the current one');
      return false;
    }
    sessionStorage.setItem(UPDATE_RELOAD_KEY, '1');
  } catch {
    // Without a way to guarantee a single reload, don't reload at all.
    return false;
  }
  logPhase('SW', 'Handover to the new worker did not land; reloading once');
  self.location.reload();
  return true;
}

function clearUpdateReloadFlag(): void {
  try {
    sessionStorage.removeItem(UPDATE_RELOAD_KEY);
  } catch {
    // Blocked storage: the flag could not have been set either.
  }
}

/**
 * Ask [controller] for the engine revision of the build it serves.
 * Resolves `null` when it does not say, or does not answer in time.
 */
function queryControllerEngine(controller: ServiceWorker): Promise<string | null> {
  const container = navigator.serviceWorker;
  const requestId = `engine-${Math.random().toString(36).slice(2)}`;

  return new Promise<string | null>((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as {
        type?: unknown;
        requestId?: unknown;
        engineRevision?: unknown;
      } | null;
      if (data?.type !== 'version' || data.requestId !== requestId) return;
      const revision = data.engineRevision;
      done(typeof revision === 'string' && revision !== '' ? revision : null);
    };
    const timer = setTimeout(() => done(null), SW_ENGINE_QUERY_TIMEOUT_MS);
    function done(revision: string | null): void {
      clearTimeout(timer);
      container.removeEventListener('message', onMessage);
      resolve(revision);
    }

    container.addEventListener('message', onMessage);
    try {
      // Messages to the page are queued until the queue is enabled, which
      // otherwise happens only once the document has finished parsing.
      container.startMessages?.();
      controller.postMessage({ type: 'getVersion', requestId });
    } catch {
      done(null);
    }
  });
}

/**
 * Resolve `true` once [worker] has installed, `false` if it turns
 * redundant (its install failed) or [timeoutMs] passes first.
 */
function waitForInstalled(worker: ServiceWorker, timeoutMs: number): Promise<boolean> {
  const settled = (): boolean | null => {
    if (worker.state === 'redundant') return false;
    if (worker.state !== 'installing' && worker.state !== 'parsed') return true;
    return null;
  };
  const now = settled();
  if (now !== null) return Promise.resolve(now);

  return new Promise<boolean>((resolve) => {
    const onChange = (): void => {
      const result = settled();
      if (result === null) return;
      clearTimeout(timer);
      worker.removeEventListener('statechange', onChange);
      resolve(result);
    };
    const timer = setTimeout(() => {
      worker.removeEventListener('statechange', onChange);
      resolve(false);
    }, timeoutMs);
    worker.addEventListener('statechange', onChange);
  });
}

/**
 * Activate a freshly-installed but waiting service worker.
 *
 * Sends `skipWaiting` to the registration's waiting worker, waits for the
 * browser to swap controllers, then resolves. Callers can then trigger a
 * page reload to pick up the new resources. Resolves to `false` when no
 * waiting worker is available, SW is unsupported, or the controller has
 * not changed within `SW_BOOTSTRAP_TIMEOUT_MS`.
 */
export async function activateWaitingSW(
  registration: ServiceWorkerRegistration,
): Promise<boolean> {
  const waiting = registration.waiting;
  if (!waiting) return false;

  const controllerChanged = new Promise<boolean>((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), {
      once: true,
    });
  });

  waiting.postMessage({ type: 'skipWaiting' });
  // A worker that turns redundant instead of activating never fires
  // `controllerchange`, and an update prompt awaiting this must not hang
  // on it. After the bound the caller gets `false` and the page stays as
  // it is.
  return withTimeout(controllerChanged, SW_BOOTSTRAP_TIMEOUT_MS, false);
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
export const FOREIGN_RELOAD_KEY = 'sw-foreign-controller-reload';

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
    // Resolve against the document base URL, exactly as
    // `navigator.serviceWorker.register(swFilename)` does. Resolving
    // against `location.href` instead would make the check depend on the
    // route the user landed on: at `/chat/42` it expects `/chat/sw.js`,
    // decides the perfectly good `/sw.js` controller is foreign, and
    // unregisters it — on every SPA deep link.
    expectedPath = new URL(swFilename, document.baseURI).pathname;
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
  //
  // Bounded like the loading widget's reset: this runs before the pipeline's
  // own deadline, and `unregister()` waits on the same per-scope job queue
  // that a stuck install wedges. The reload is unconditional.
  try {
    await withTimeout(
      (async () => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        const doomed = registrations.find(
          (reg) => reg.active?.scriptURL === controller.scriptURL,
        );
        if (doomed) {
          await doomed.unregister();
        }
      })(),
      RESET_TIMEOUT_MS,
      undefined,
    );
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
