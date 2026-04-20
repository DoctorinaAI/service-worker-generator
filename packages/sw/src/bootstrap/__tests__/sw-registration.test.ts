/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerServiceWorker,
  listenForSWMessages,
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
