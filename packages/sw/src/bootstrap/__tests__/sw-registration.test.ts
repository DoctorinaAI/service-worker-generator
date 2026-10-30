/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  activateWaitingSW,
  registerServiceWorker,
  listenForSWMessages,
  reloadIfForeignController,
  settleUpdateAtBootstrap,
} from '../sw-registration';
import {
  RESET_TIMEOUT_MS,
  SW_BOOTSTRAP_TIMEOUT_MS,
  SW_ENGINE_QUERY_TIMEOUT_MS,
  SW_HANDOFF_TIMEOUT_MS,
  SW_UPDATE_INSTALL_TIMEOUT_MS,
  SW_REGISTRATION_TIMEOUT_MS,
} from '../../shared/constants';

interface FakeWorker {
  state: 'installing' | 'installed' | 'activating' | 'activated' | 'redundant';
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

  it('encodes the version, so the worker reads back a version with a +', async () => {
    const register = vi.fn<(url: string) => Promise<unknown>>(async () =>
      makeRegistration(makeWorker('activated'), 'active'),
    );
    installSwContainer({ register });

    await registerServiceWorker('sw.js', '1.0.0+3');
    const url = register.mock.calls[0][0];
    expect(url).toBe('sw.js?v=1.0.0%2B3');
    expect(new URL(url, 'https://example.com/').searchParams.get('v')).toBe('1.0.0+3');
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

  it('gives up and returns null when register() never settles', async () => {
    vi.useFakeTimers();
    // A wedged scope job queue: an install elsewhere never finished, so the
    // browser leaves this promise pending instead of rejecting it. Without a
    // deadline the whole bootstrap waits here and the app never starts.
    const register = vi.fn(() => new Promise<never>(() => {}));
    installSwContainer({ register });

    const promise = registerServiceWorker('sw.js', 'v1');
    await vi.advanceTimersByTimeAsync(SW_BOOTSTRAP_TIMEOUT_MS + 1);

    await expect(promise).resolves.toBeNull();
  });

  it('gives up when the pre-registration cleanup never settles', async () => {
    vi.useFakeTimers();
    // The same wedge reaches `getRegistrations()`/`unregister()`, which run
    // before `register()` is even called — so the deadline has to cover the
    // whole step, not just the registration call.
    const oldWorker = makeWorker('activated', '/flutter_service_worker.js');
    const oldReg = makeRegistration(oldWorker, 'active');
    oldReg.unregister = vi.fn(() => new Promise<boolean>(() => {}));
    const register = vi.fn(async () => makeRegistration(makeWorker('activated'), 'active'));
    installSwContainer({ register, registrations: [oldReg] });

    const promise = registerServiceWorker('sw.js', 'v1');
    await vi.advanceTimersByTimeAsync(SW_BOOTSTRAP_TIMEOUT_MS + 1);

    await expect(promise).resolves.toBeNull();
    expect(register).not.toHaveBeenCalled();
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

  it('falls back to waitForActivation if the handoff times out on an uncontrolled page', async () => {
    vi.useFakeTimers();
    const waiting = makeWorker('installed', '/sw.js?v=new');
    const active = makeWorker('activated', '/sw.js?v=old');
    const registration = makeRegistration(waiting, 'waiting');
    registration.active = active;
    (waiting as unknown as { postMessage: () => void }).postMessage = vi.fn();
    const register = vi.fn(async () => registration);
    installSwContainer({ register });

    let settled = false;
    const promise = registerServiceWorker('sw.js', 'new').then((r) => {
      settled = true;
      return r;
    });
    // No controller, so after the short handoff bound the pipeline still
    // waits for activation, as on a first visit.
    await vi.advanceTimersByTimeAsync(SW_HANDOFF_TIMEOUT_MS + 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(SW_REGISTRATION_TIMEOUT_MS);
    expect(settled).toBe(true);
    await expect(promise).resolves.toBe(registration);
  });

  it('does not wait for a newly installing worker when the page already has a controller', async () => {
    vi.useFakeTimers();
    // The first load after a deploy: register() starts installing the new
    // build while the previous one controls this page, so the new worker
    // cannot activate before the page closes. Whether to switch to it is
    // settleUpdateAtBootstrap's decision, not a 4s wait here.
    const installing = makeWorker('installing', '/sw.js?v=new');
    const registration = makeRegistration(installing, 'installing');
    registration.active = makeWorker('activated', '/sw.js?v=old');
    const register = vi.fn(async () => registration);
    installSwContainer({ register, controller: registration.active });

    const promise = registerServiceWorker('sw.js', 'new');
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBe(registration);
    vi.useRealTimers();
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

  it('announces a worker that starts installing after registration', async () => {
    // A long-lived tab: a later deploy reaches it through `updatefound`,
    // not through the worker present at registration.
    const registration = makeRegistration(makeWorker('activated'), 'active');
    const register = vi.fn(async () => registration);
    installSwContainer({ register, controller: registration.active });
    const spy = vi.fn();
    window.addEventListener('sw-update-available', spy as EventListener);

    try {
      await registerServiceWorker('sw.js', 'v1');
      expect(registration._updateHandlers).toHaveLength(1);

      const next = makeWorker('installing', '/sw.js?v=v2');
      registration.installing = next;
      registration._updateHandlers.forEach((cb) => cb());
      next.state = 'installed';
      next._listeners.forEach((cb) => cb());

      expect(spy).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('sw-update-available', spy as EventListener);
    }
  });

  it('ignores an updatefound without an installing worker', async () => {
    const registration = makeRegistration(makeWorker('activated'), 'active');
    installSwContainer({ register: vi.fn(async () => registration) });
    await registerServiceWorker('sw.js', 'v1');
    expect(() => registration._updateHandlers.forEach((cb) => cb())).not.toThrow();
  });

  it('resolves as soon as a first install activates, not at the timeout', async () => {
    vi.useFakeTimers();
    const worker = makeWorker('installing');
    const registration = makeRegistration(worker, 'installing');
    installSwContainer({ register: vi.fn(async () => registration) });

    let settled = false;
    const promise = registerServiceWorker('sw.js', 'v1').then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(0);
    worker.state = 'activating';
    worker._listeners.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    worker.state = 'activated';
    worker._listeners.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(promise).resolves.toBe(registration);
  });

  it('returns the registration when it has no worker at all', async () => {
    const registration = makeRegistration(null);
    installSwContainer({ register: vi.fn(async () => registration) });
    await expect(registerServiceWorker('sw.js', 'v1')).resolves.toBe(registration);
  });

  it('boots with the current controller once a handover has not landed within its bound', async () => {
    vi.useFakeTimers();
    // A lost handover: the old worker was restarted for a request this page
    // made, and the browser holds the new one back while the page is open.
    // Waiting longer cannot change that, so the bound is the whole cost,
    // and there is no second wait for activation after it.
    const waiting = makeWorker('installed', '/sw.js?v=new');
    (waiting as unknown as { postMessage: () => void }).postMessage = vi.fn();
    const registration = makeRegistration(waiting, 'waiting');
    registration.active = makeWorker('activated', '/sw.js?v=old');
    installSwContainer({
      register: vi.fn(async () => registration),
      controller: registration.active,
    });

    let settled = false;
    const promise = registerServiceWorker('sw.js', 'new').then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(SW_HANDOFF_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    await expect(promise).resolves.toBe(registration);
  });

  it('also removes a legacy flutter_sw worker before registering', async () => {
    const legacy = makeRegistration(makeWorker('activated', '/flutter_sw.js'), 'active');
    const ours = makeRegistration(makeWorker('activated', '/sw.js?v=1'), 'active');
    const register = vi.fn(async () => makeRegistration(makeWorker('activated'), 'active'));
    installSwContainer({ register, registrations: [legacy, ours] });

    await registerServiceWorker('sw.js', 'v1');
    expect(legacy.unregister).toHaveBeenCalledOnce();
    expect(ours.unregister).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledOnce();
  });

  it('still registers when listing registrations fails', async () => {
    const container = installSwContainer({
      register: vi.fn(async () => makeRegistration(makeWorker('activated'), 'active')),
    });
    container.getRegistrations.mockRejectedValueOnce(new Error('SecurityError'));
    await expect(registerServiceWorker('sw.js', 'v1')).resolves.not.toBeNull();
    expect(container.register).toHaveBeenCalledOnce();
  });
});

describe('reloadIfForeignController', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let reloadSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;
  let baseElement: HTMLBaseElement;

  /**
   * The SW path is resolved against the document base URL, the same input
   * `navigator.serviceWorker.register` uses — so tests drive it through a
   * real `<base>` element rather than through `location`.
   */
  function setBase(href: string): void {
    baseElement.href = href;
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sessionStorage.clear();
    baseElement = document.createElement('base');
    baseElement.href = 'https://example.com/app/';
    document.head.appendChild(baseElement);
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
    baseElement.remove();
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

  it('accepts our own controller on a deep route', async () => {
    // An SPA deep link. Resolving `sw.js` against the *document URL* would
    // expect `/app/chat/42/sw.js` here and unregister the real worker.
    setBase('https://example.com/app/');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: 'https://example.com/app/chat/42', reload: reloadSpy },
    });
    installSwContainer({
      controller: { scriptURL: 'https://example.com/app/sw.js?v=abc' },
    });

    expect(await reloadIfForeignController('sw.js')).toBe(false);
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

  it('reloads anyway when unregister() never settles', async () => {
    // A wedged job queue holds unregister() as well as register(). This
    // runs before the pipeline's own deadline, so it needs one of its own.
    vi.useFakeTimers();
    const foreignReg = makeRegistration(
      makeWorker('activated', 'https://example.com/flutter_service_worker.js'),
      'active',
    );
    foreignReg.unregister = vi.fn(() => new Promise<boolean>(() => undefined));
    installSwContainer({
      controller: {
        scriptURL: 'https://example.com/flutter_service_worker.js',
      },
      registrations: [foreignReg],
    });

    const promise = reloadIfForeignController('sw.js');
    await vi.advanceTimersByTimeAsync(RESET_TIMEOUT_MS + 1);
    await expect(promise).resolves.toBe(true);
    expect(reloadSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
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
    // Swap the whole object rather than spying on Storage.prototype:
    // jsdom does not route sessionStorage calls through the prototype
    // method, so a prototype spy silently never fires.
    const realStorage = window.sessionStorage;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (): string | null => null,
        setItem: (): never => {
          throw new Error('blocked');
        },
      },
    });

    try {
      const result = await reloadIfForeignController('sw.js');
      expect(result).toBe(false);
      expect(reloadSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: realStorage,
      });
    }
  });

  it('leaves a controller whose script URL it cannot parse alone', async () => {
    // Undecidable is not foreign: unregistering on a guess could take out
    // our own worker.
    const reg = makeRegistration(makeWorker('activated', 'not a url'), 'active');
    installSwContainer({ controller: { scriptURL: 'not a url' }, registrations: [reg] });
    expect(await reloadIfForeignController('sw.js')).toBe(false);
    expect(reg.unregister).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('does nothing when the SW filename does not resolve to a URL', async () => {
    installSwContainer({
      controller: { scriptURL: 'https://example.com/flutter_service_worker.js' },
    });
    expect(await reloadIfForeignController('http://[')).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads when the foreign controller has no registration left to remove', async () => {
    installSwContainer({
      controller: { scriptURL: 'https://example.com/flutter_service_worker.js' },
      registrations: [],
    });
    expect(await reloadIfForeignController('sw.js')).toBe(true);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });
});

describe('activateWaitingSW', () => {
  afterEach(() => {
    vi.useRealTimers();
    try {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    } catch {
      // ignore
    }
  });

  function waitingRegistration(): FakeRegistration {
    const waiting = makeWorker('installed', '/sw.js?v=new');
    (waiting as unknown as { postMessage: () => void }).postMessage = vi.fn();
    return makeRegistration(waiting, 'waiting');
  }

  it('resolves true once the controller changes', async () => {
    const container = installSwContainer({});
    const promise = activateWaitingSW(
      waitingRegistration() as unknown as ServiceWorkerRegistration,
    );
    const onChange = container.addEventListener.mock.calls.find(
      (c) => c[0] === 'controllerchange',
    )![1] as () => void;
    onChange();
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false instead of hanging when the controller never changes', async () => {
    // The waiting worker turned redundant: no controllerchange will come,
    // and an update prompt awaiting applyUpdate() must not hang on it.
    vi.useFakeTimers();
    installSwContainer({});
    const promise = activateWaitingSW(
      waitingRegistration() as unknown as ServiceWorkerRegistration,
    );
    await vi.advanceTimersByTimeAsync(SW_BOOTSTRAP_TIMEOUT_MS + 1);
    await expect(promise).resolves.toBe(false);
  });

  it('resolves false when there is no waiting worker', async () => {
    installSwContainer({});
    await expect(
      activateWaitingSW(makeRegistration(null) as unknown as ServiceWorkerRegistration),
    ).resolves.toBe(false);
  });
});

describe('settleUpdateAtBootstrap', () => {
  const NEW_ENGINE = 'engine-new-0000';
  let logSpy: ReturnType<typeof vi.spyOn>;
  let reloadSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sessionStorage.clear();
    originalLocation = window.location;
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
    try {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    } catch {
      // ignore
    }
  });

  /**
   * The previous build's worker, controlling the page. [engine] is what it
   * puts in its `getVersion` reply: a revision, `undefined` for a worker
   * from a release that predates the field, or `null` for no reply.
   */
  function setUp(options: {
    engine: string | undefined | null;
    pendingState: 'installing' | 'installed';
  }): {
    registration: FakeRegistration;
    pending: FakeWorker & { postMessage: ReturnType<typeof vi.fn> };
    controller: { scriptURL: string; postMessage: ReturnType<typeof vi.fn> };
    container: ReturnType<typeof installSwContainer>;
    install: () => void;
    fail: () => void;
    changeController: () => void;
  } {
    const pending = makeWorker(options.pendingState, '/sw.js?v=new') as FakeWorker & {
      postMessage: ReturnType<typeof vi.fn>;
    };
    pending.postMessage = vi.fn();
    const registration = makeRegistration(
      pending,
      options.pendingState === 'installing' ? 'installing' : 'waiting',
    );
    registration.active = makeWorker('activated', '/sw.js?v=old');

    const controller = {
      scriptURL: '/sw.js?v=old',
      postMessage: vi.fn((msg: { type: string; requestId: string }) => {
        if (options.engine === null || msg.type !== 'getVersion') return;
        const data: Record<string, string> = {
          type: 'version',
          version: 'old',
          requestId: msg.requestId,
        };
        if (options.engine !== undefined) data.engineRevision = options.engine;
        queueMicrotask(() => {
          for (const cb of [...container._messageListeners]) {
            cb({ data } as MessageEvent);
          }
        });
      }),
    };
    const container = installSwContainer({ controller });
    container.removeEventListener.mockImplementation(
      (evt: string, cb: (e: MessageEvent) => void) => {
        if (evt !== 'message') return;
        const idx = container._messageListeners.indexOf(cb);
        if (idx >= 0) container._messageListeners.splice(idx, 1);
      },
    );

    return {
      registration,
      pending,
      controller,
      container,
      install: () => {
        pending.state = 'installed';
        registration.installing = null;
        registration.waiting = pending;
        pending._listeners.forEach((cb) => cb());
      },
      fail: () => {
        pending.state = 'redundant';
        registration.installing = null;
        pending._listeners.forEach((cb) => cb());
      },
      changeController: () => {
        for (const call of container.addEventListener.mock.calls) {
          if (call[0] === 'controllerchange') (call[1] as () => void)();
        }
      },
    };
  }

  const settle = (registration: FakeRegistration): Promise<boolean> =>
    settleUpdateAtBootstrap(
      registration as unknown as ServiceWorkerRegistration,
      NEW_ENGINE,
    );

  it('does nothing when no newer worker is pending', async () => {
    const { registration, controller } = setUp({ engine: NEW_ENGINE, pendingState: 'installing' });
    registration.installing = null;
    await expect(settle(registration)).resolves.toBe(false);
    expect(controller.postMessage).not.toHaveBeenCalled();
  });

  it('boots with the current worker at once when the engine is the same', async () => {
    const { registration, pending } = setUp({ engine: NEW_ENGINE, pendingState: 'installing' });
    await expect(settle(registration)).resolves.toBe(false);
    expect(pending.postMessage).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('switches to the new worker before booting when the engine changed', async () => {
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.waitFor(() =>
      expect(env.pending._listeners.length).toBeGreaterThan(0),
    );
    // Not before it has installed: an installing worker cannot take over.
    expect(env.pending.postMessage).not.toHaveBeenCalled();

    env.install();
    await vi.waitFor(() =>
      expect(env.pending.postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' }),
    );
    env.changeController();

    await expect(result).resolves.toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('treats a worker that does not report its engine as a different engine', async () => {
    // Every worker generated before this release replies without it.
    const env = setUp({ engine: undefined, pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.waitFor(() => expect(env.pending._listeners.length).toBeGreaterThan(0));
    env.install();
    await vi.waitFor(() => expect(env.pending.postMessage).toHaveBeenCalled());
    env.changeController();
    await expect(result).resolves.toBe(false);
  });

  it('treats a controller that does not answer as a different engine', async () => {
    vi.useFakeTimers();
    const env = setUp({ engine: null, pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.advanceTimersByTimeAsync(SW_ENGINE_QUERY_TIMEOUT_MS + 1);
    expect(env.pending._listeners.length).toBeGreaterThan(0);
    env.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.pending.postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' });
    env.changeController();
    await expect(result).resolves.toBe(false);
  });

  it('boots with the current worker when the new one fails to install', async () => {
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.waitFor(() => expect(env.pending._listeners.length).toBeGreaterThan(0));
    env.fail();
    await expect(result).resolves.toBe(false);
    expect(env.pending.postMessage).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('gives up waiting for an install after its budget', async () => {
    vi.useFakeTimers();
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.advanceTimersByTimeAsync(SW_UPDATE_INSTALL_TIMEOUT_MS + 1);
    await expect(result).resolves.toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads once when the handover is lost, and not again', async () => {
    vi.useFakeTimers();
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installing' });
    const first = settle(env.registration);
    await vi.advanceTimersByTimeAsync(0);
    env.install();
    // No controllerchange: the handover lost its race, and the reload
    // follows its bound, not the 4s activation timeout.
    await vi.advanceTimersByTimeAsync(SW_HANDOFF_TIMEOUT_MS + 1);
    await expect(first).resolves.toBe(true);
    expect(reloadSpy).toHaveBeenCalledOnce();

    // The reloaded page finds the same state: it boots instead of looping.
    const again = setUp({ engine: 'engine-old-0000', pendingState: 'installed' });
    await expect(settle(again.registration)).resolves.toBe(false);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('does not reload when another tab already handed control to the new worker', async () => {
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.waitFor(() => expect(env.pending._listeners.length).toBeGreaterThan(0));
    // The other tab's skipWaiting: the worker activates and takes this page.
    env.pending.state = 'activated';
    env.registration.installing = null;
    env.registration.waiting = null;
    env.registration.active = env.pending;
    (env.container as unknown as { controller: unknown }).controller = env.pending;
    env.pending._listeners.forEach((cb) => cb());
    await expect(result).resolves.toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('does not reload when the controller changes just after the handover timed out', async () => {
    vi.useFakeTimers();
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.advanceTimersByTimeAsync(0);
    env.install();
    await vi.advanceTimersByTimeAsync(SW_HANDOFF_TIMEOUT_MS - 1);
    // Too late for the handover's race, but before the reload decision.
    (env.container as unknown as { controller: unknown }).controller = env.pending;
    await vi.advanceTimersByTimeAsync(2);
    await expect(result).resolves.toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads without a second handover when one already failed at registration', async () => {
    // A worker already waiting at bootstrap had its handover attempt in
    // registerAndActivate; repeating it would only cost the timeout again.
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installed' });
    await expect(settle(env.registration)).resolves.toBe(true);
    expect(env.pending.postMessage).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  /** Replace sessionStorage with one whose every access throws. */
  function blockSessionStorage(): () => void {
    const real = window.sessionStorage;
    const blocked = (): never => {
      throw new DOMException('Access is denied', 'SecurityError');
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: blocked, setItem: blocked, removeItem: blocked },
    });
    return () =>
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: real,
      });
  }

  it('boots instead of reloading when session storage is blocked', async () => {
    // Without the one-shot flag a reload could not be limited to one, so
    // the page must not reload at all rather than risk a loop.
    vi.useFakeTimers();
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installed' });
    const restore = blockSessionStorage();
    try {
      await expect(settle(env.registration)).resolves.toBe(false);
      expect(reloadSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('tolerates blocked session storage on a page with nothing pending', async () => {
    const { registration } = setUp({ engine: NEW_ENGINE, pendingState: 'installing' });
    registration.installing = null;
    const restore = blockSessionStorage();
    try {
      await expect(settle(registration)).resolves.toBe(false);
    } finally {
      restore();
    }
  });

  it('does not query or wait on a page without a controller', async () => {
    // A first visit, or a hard reload: everything comes from the network,
    // so there is no previous build to keep away from this engine.
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installing' });
    (env.container as unknown as { controller: unknown }).controller = null;
    sessionStorage.setItem('sw-engine-update-reload', '1');

    await expect(settle(env.registration)).resolves.toBe(false);
    expect(env.controller.postMessage).not.toHaveBeenCalled();
    expect(env.pending._listeners).toHaveLength(0);
    // The guard is re-armed for the next deploy in this tab.
    expect(sessionStorage.getItem('sw-engine-update-reload')).toBeNull();
  });

  it('re-arms the reload guard once a handover lands', async () => {
    // The flag a previous reload left must not block the next deploy's
    // recovery in the same tab.
    sessionStorage.setItem('sw-engine-update-reload', '1');
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.waitFor(() => expect(env.pending._listeners.length).toBeGreaterThan(0));
    env.install();
    await vi.waitFor(() => expect(env.pending.postMessage).toHaveBeenCalled());
    env.changeController();

    await expect(result).resolves.toBe(false);
    expect(sessionStorage.getItem('sw-engine-update-reload')).toBeNull();
  });

  it('does not take a reply to another request for its own', async () => {
    // Another `getVersion` round trip on the page (an app's own, say) must
    // not answer this one: here it carries the new engine and would skip
    // the switch.
    vi.useFakeTimers();
    const env = setUp({ engine: null, pendingState: 'installing' });
    env.controller.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        for (const cb of [...env.container._messageListeners]) {
          cb({
            data: { type: 'version', requestId: 'someone-else', engineRevision: NEW_ENGINE },
          } as MessageEvent);
          cb({ data: null } as MessageEvent);
        }
      });
    });

    const result = settle(env.registration);
    await vi.advanceTimersByTimeAsync(SW_ENGINE_QUERY_TIMEOUT_MS + 1);
    // Unknown engine: waiting for the install, not booting on the old worker.
    expect(env.pending._listeners.length).toBeGreaterThan(0);
    env.fail();
    await expect(result).resolves.toBe(false);
  });

  it('treats a controller it cannot message as unknown, without waiting out the query', async () => {
    vi.useFakeTimers();
    const env = setUp({ engine: NEW_ENGINE, pendingState: 'installing' });
    env.controller.postMessage.mockImplementation(() => {
      throw new DOMException('worker gone', 'InvalidStateError');
    });

    const result = settle(env.registration);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.pending._listeners.length).toBeGreaterThan(0);
    env.fail();
    await expect(result).resolves.toBe(false);
  });

  it('stops listening for the reply once it has one', async () => {
    const { registration, container } = setUp({ engine: NEW_ENGINE, pendingState: 'installing' });
    await settle(registration);
    expect(container._messageListeners).toHaveLength(0);
  });

  it('keeps waiting through a state change that is not yet an install', async () => {
    vi.useFakeTimers();
    const env = setUp({ engine: 'engine-old-0000', pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.advanceTimersByTimeAsync(0);

    env.pending._listeners.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(env.pending.postMessage).not.toHaveBeenCalled();

    env.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.pending.postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' });
    env.changeController();
    await expect(result).resolves.toBe(false);
  });

  it('is bounded when the controller is silent and the install never ends', async () => {
    // The step runs after the registration deadline, so its own bounds are
    // all that keep the page from hanging here.
    vi.useFakeTimers();
    const env = setUp({ engine: null, pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.advanceTimersByTimeAsync(
      SW_ENGINE_QUERY_TIMEOUT_MS + SW_UPDATE_INSTALL_TIMEOUT_MS + 1,
    );
    await expect(result).resolves.toBe(false);
    expect(env.pending._listeners).toHaveLength(0);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('is bounded when the install lands but the handover never does', async () => {
    vi.useFakeTimers();
    const env = setUp({ engine: null, pendingState: 'installing' });
    const result = settle(env.registration);
    await vi.advanceTimersByTimeAsync(SW_ENGINE_QUERY_TIMEOUT_MS + 1);
    env.install();
    await vi.advanceTimersByTimeAsync(SW_HANDOFF_TIMEOUT_MS + 1);
    await expect(result).resolves.toBe(true);
    expect(reloadSpy).toHaveBeenCalledOnce();
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
