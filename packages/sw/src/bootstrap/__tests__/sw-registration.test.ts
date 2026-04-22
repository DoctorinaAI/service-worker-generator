/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerServiceWorker,
  listenForSWMessages,
  reloadIfForeignController,
} from '../sw-registration';
import { SW_REGISTRATION_TIMEOUT_MS } from '../../shared/constants';

interface FakeWorker {
  state: 'installing' | 'installed' | 'activating' | 'activated';
  scriptURL: string;
  _listeners: Array<() => void>;
  addEventListener: (evt: 'statechange', cb: () => void) => void;
  removeEventListener: (evt: 'statechange', cb: () => void) => void;
}

interface FakeRegistration {
  installing: FakeWorker | null;
  waiting: FakeWorker | null;
  active: FakeWorker | null;
  scope: string;
  _updateHandlers: Array<() => void>;
  addEventListener: (evt: 'updatefound', cb: () => void) => void;
  unregister: ReturnType<typeof vi.fn>;
}

function makeWorker(
  state: FakeWorker['state'] = 'installing',
  scriptURL = '/sw.js',
): FakeWorker {
  const w: FakeWorker = {
    state,
    scriptURL,
    _listeners: [],
    addEventListener: (_evt, cb) => {
      w._listeners.push(cb);
    },
    removeEventListener: (_evt, cb) => {
      w._listeners = w._listeners.filter((x) => x !== cb);
    },
  };
  return w;
}

function makeRegistration(
  worker: FakeWorker | null,
  slot: 'installing' | 'waiting' | 'active' = 'installing',
): FakeRegistration {
  const reg: FakeRegistration = {
    installing: slot === 'installing' ? worker : null,
    waiting: slot === 'waiting' ? worker : null,
    active: slot === 'active' ? worker : null,
    scope: '/',
    _updateHandlers: [],
    addEventListener: (_evt, cb) => {
      reg._updateHandlers.push(cb);
    },
    unregister: vi.fn(async () => true),
  };
  return reg;
}

function installSwContainer(opts: {
  register?: ReturnType<typeof vi.fn>;
  registrations?: FakeRegistration[];
  controller?: unknown;
}): {
  register: ReturnType<typeof vi.fn>;
  getRegistrations: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  _messageListeners: Array<(event: MessageEvent) => void>;
} {
  const messageListeners: Array<(event: MessageEvent) => void> = [];
  const container = {
    register: opts.register ?? vi.fn(),
    getRegistrations: vi.fn(async () => opts.registrations ?? []),
    addEventListener: vi.fn((evt: string, cb: (e: MessageEvent) => void) => {
      if (evt === 'message') messageListeners.push(cb);
    }),
    removeEventListener: vi.fn(
      (evt: string, cb: (e: MessageEvent) => void) => {
        if (evt === 'message') {
          const idx = messageListeners.indexOf(cb);
          if (idx >= 0) messageListeners.splice(idx, 1);
        }
      },
    ),
    controller: opts.controller ?? null,
    _messageListeners: messageListeners,
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    get: () => container,
  });
  return container as unknown as ReturnType<typeof installSwContainer>;
}

describe('registerServiceWorker', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Remove serviceWorker override so next test resets cleanly
    try {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    } catch {
      // ignore
    }
  });

  it('returns null when navigator.serviceWorker is unavailable', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      get: () => undefined,
    });
    // `'serviceWorker' in navigator` should be false — but `defineProperty`
    // with getter keeps the prop. Delete instead.
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    const result = await registerServiceWorker('sw.js', 'v1');
    expect(result).toBeNull();
  });

  it('registers sw.js with a versioned URL and updateViaCache: none', async () => {
    const worker = makeWorker('activated');
    const registration = makeRegistration(worker, 'active');
    const register = vi.fn<
      (url: string, options: RegistrationOptions) => Promise<unknown>
    >(async () => registration);
    installSwContainer({ register });

    await registerServiceWorker('sw.js', 'abc123');
    expect(register).toHaveBeenCalledOnce();
    const [url, options] = register.mock.calls[0];
    expect(url).toBe('sw.js?v=abc123');
    expect(options).toEqual({ updateViaCache: 'none' });
  });

  it('returns the registration when activation happens before the timeout', async () => {
    const worker = makeWorker('installing');
    const registration = makeRegistration(worker, 'installing');
    const register = vi.fn(async () => registration);
    installSwContainer({ register });

    const promise = registerServiceWorker('sw.js', 'v1');
    // Transition to activated and fire the listeners.
    await Promise.resolve();
    worker.state = 'activated';
    worker._listeners.forEach((cb) => cb());

    const result = await promise;
    expect(result).toBe(registration);
  });

  it('times out and still returns the registration if activation never happens', async () => {
    vi.useFakeTimers();
    const worker = makeWorker('installing');
    const registration = makeRegistration(worker, 'installing');
    const register = vi.fn(async () => registration);
    installSwContainer({ register });

    const promise = registerServiceWorker('sw.js', 'v1');
    await vi.advanceTimersByTimeAsync(SW_REGISTRATION_TIMEOUT_MS + 1);
    const result = await promise;
    expect(result).toBe(registration);
  });

  it('returns null when register() throws', async () => {
    const register = vi.fn(async () => {
      throw new Error('blocked');
    });
    installSwContainer({ register });

    const result = await registerServiceWorker('sw.js', 'v1');
    expect(result).toBeNull();
  });

  it('unregisters an existing Flutter-generated SW before registering a new one', async () => {
    const oldWorker = makeWorker('activated', '/flutter_service_worker.js');
    const oldReg = makeRegistration(oldWorker, 'active');
    const newWorker = makeWorker('activated');
    const newReg = makeRegistration(newWorker, 'active');
    const register = vi.fn(async () => newReg);
    installSwContainer({ register, registrations: [oldReg] });

    await registerServiceWorker('sw.js', 'v1');
    expect(oldReg.unregister).toHaveBeenCalledOnce();
  });

  it('auto-activates a pre-existing waiting worker during bootstrap via skipWaiting', async () => {
    const waiting = makeWorker('installed', '/sw.js?v=new');
    const active = makeWorker('activated', '/sw.js?v=old');
    const registration = makeRegistration(waiting, 'waiting');
    registration.active = active;
    const postMessage = vi.fn();
    (waiting as unknown as { postMessage: typeof postMessage }).postMessage =
      postMessage;
    const register = vi.fn(async () => registration);
    const container = installSwContainer({ register });

    const promise = registerServiceWorker('sw.js', 'new');
    // Let register() + activateWaitingAtBootstrap attach listeners.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' });

    // Simulate the browser firing controllerchange once the new worker
    // takes over.
    const changeListeners = container.addEventListener.mock.calls
      .filter((c) => c[0] === 'controllerchange')
      .map((c) => c[1] as () => void);
    changeListeners.forEach((cb) => cb());

    const result = await promise;
    expect(result).toBe(registration);
  });

  it('falls back to waitForActivation if the waiting-worker handoff times out', async () => {
    vi.useFakeTimers();
    const waiting = makeWorker('installed', '/sw.js?v=new');
    const active = makeWorker('activated', '/sw.js?v=old');
    const registration = makeRegistration(waiting, 'waiting');
    registration.active = active;
    (waiting as unknown as { postMessage: () => void }).postMessage = vi.fn();
    const register = vi.fn(async () => registration);
    installSwContainer({ register });

    const promise = registerServiceWorker('sw.js', 'new');
    // Advance past both the activate-at-bootstrap timeout AND the
    // waitForActivation timeout (same duration, chained sequentially).
    await vi.advanceTimersByTimeAsync(SW_REGISTRATION_TIMEOUT_MS * 2 + 1);
    const result = await promise;
    expect(result).toBe(registration);
  });

  it('dispatches sw-update-available when a new worker installs alongside an active controller', async () => {
    const worker = makeWorker('installing');
    const registration = makeRegistration(worker, 'installing');
    const register = vi.fn(async () => registration);
    installSwContainer({ register, controller: {} });

    const spy = vi.fn();
    window.addEventListener('sw-update-available', spy as EventListener);

    const regPromise = registerServiceWorker('sw.js', 'v1');
    // Yield several microtasks so unregister + register + wireUpdateDetection
    // all run before we transition the worker state.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    worker.state = 'installed';
    worker._listeners.forEach((cb) => cb());

    // Now let the worker activate so waitForActivation resolves immediately.
    worker.state = 'activated';
    worker._listeners.forEach((cb) => cb());

    await regPromise;
    expect(spy).toHaveBeenCalled();
    window.removeEventListener('sw-update-available', spy as EventListener);
  });
});

describe('reloadIfForeignController', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let reloadSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sessionStorage.clear();
    // Replace location with a stub we can observe reload() on. JSDOM's
    // Location is non-configurable by default, but we can redefine it on
    // window with configurable: true for the duration of the test.
    originalLocation = window.location;
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        href: 'https://example.com/app/',
        reload: reloadSpy,
      },
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    sessionStorage.clear();
    try {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    } catch {
      // ignore
    }
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
    vi.restoreAllMocks();
  });

  it('returns false when serviceWorker is unsupported', async () => {
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    const result = await reloadIfForeignController('sw.js');
    expect(result).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('returns false when there is no controller (first-ever load)', async () => {
    installSwContainer({ controller: null });
    const result = await reloadIfForeignController('sw.js');
    expect(result).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('returns false when the controller scriptURL pathname matches expected', async () => {
    installSwContainer({
      controller: { scriptURL: 'https://example.com/app/sw.js?v=abc' },
    });
    const result = await reloadIfForeignController('sw.js');
    expect(result).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads exactly once when a foreign controller is detected', async () => {
    const foreignReg = makeRegistration(
      makeWorker('activated', 'https://example.com/flutter_service_worker.js'),
      'active',
    );
    installSwContainer({
      controller: {
        scriptURL: 'https://example.com/flutter_service_worker.js',
      },
      registrations: [foreignReg],
    });

    const result = await reloadIfForeignController('sw.js');
    expect(result).toBe(true);
    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(foreignReg.unregister).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('sw-foreign-controller-reload')).toBe('1');
  });

  it('does not reload a second time if the guard flag is set', async () => {
    sessionStorage.setItem('sw-foreign-controller-reload', '1');
    installSwContainer({
      controller: {
        scriptURL: 'https://example.com/flutter_service_worker.js',
      },
    });

    const result = await reloadIfForeignController('sw.js');
    expect(result).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('preserves our own registration when cleaning up foreign ones', async () => {
    const foreignReg = makeRegistration(
      makeWorker('activated', 'https://example.com/flutter_service_worker.js'),
      'active',
    );
    const ourReg = makeRegistration(
      makeWorker('activated', 'https://example.com/app/sw.js?v=new'),
      'active',
    );
    installSwContainer({
      controller: {
        scriptURL: 'https://example.com/flutter_service_worker.js',
      },
      registrations: [foreignReg, ourReg],
    });

    await reloadIfForeignController('sw.js');
    expect(foreignReg.unregister).toHaveBeenCalledOnce();
    expect(ourReg.unregister).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('preserves unrelated registrations like firebase-messaging-sw.js', async () => {
    const foreignReg = makeRegistration(
      makeWorker('activated', 'https://example.com/flutter_service_worker.js'),
      'active',
    );
    const pushReg = makeRegistration(
      makeWorker(
        'activated',
        'https://example.com/firebase-messaging-sw.js',
      ),
      'active',
    );
    // Different scope: the push SW isn't the page's controller, so it
    // must not be unregistered when we clean up the foreign page-scope SW.
    pushReg.scope = '/firebase-cloud-messaging-push-scope/';
    installSwContainer({
      controller: {
        scriptURL: 'https://example.com/flutter_service_worker.js',
      },
      registrations: [foreignReg, pushReg],
    });

    await reloadIfForeignController('sw.js');
    expect(foreignReg.unregister).toHaveBeenCalledOnce();
    expect(pushReg.unregister).not.toHaveBeenCalled();
  });

  it('bails out safely when sessionStorage throws (privacy mode)', async () => {
    installSwContainer({
      controller: {
        scriptURL: 'https://example.com/flutter_service_worker.js',
      },
    });
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });

    const result = await reloadIfForeignController('sw.js');
    expect(result).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });
});

describe('listenForSWMessages', () => {
  afterEach(() => {
    try {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it('invokes callback only for sw-progress messages', () => {
    const container = installSwContainer({});
    const callback = vi.fn();
    listenForSWMessages(callback);

    const send = (data: unknown) =>
      container._messageListeners.forEach((cb) =>
        cb({ data } as unknown as MessageEvent),
      );

    send({ type: 'sw-progress', payload: 1 });
    send({ type: 'other' });
    send(undefined);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ type: 'sw-progress', payload: 1 });
  });

  it('returns a cleanup function that removes the listener', () => {
    const container = installSwContainer({});
    const callback = vi.fn();
    const stop = listenForSWMessages(callback);
    stop();

    container._messageListeners.forEach((cb) =>
      cb({ data: { type: 'sw-progress' } } as unknown as MessageEvent),
    );
    expect(callback).not.toHaveBeenCalled();
  });
});
