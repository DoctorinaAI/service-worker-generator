import {
  FETCH_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
} from './constants';

/**
 * Format bytes into a human-readable string.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Path the worker is registered under, relative to the origin root, with a
 * trailing slash: `''` at the root, `app/` for an app served from `/app/`.
 *
 * Derived from `registration.scope` rather than `location`, because the two
 * disagree for a worker that redirects or is served through a rewrite, and
 * scope is what actually bounds the fetch events we see. Returns `''`
 * outside a service worker, so the shared module stays importable from the
 * bootstrap bundle.
 */
export function getScopePath(): string {
  try {
    const scope = (
      self as unknown as { registration?: { scope?: string } }
    ).registration?.scope;
    if (!scope) return '';
    const path = new URL(scope).pathname;
    return path.startsWith('/') ? path.slice(1) : path;
  } catch {
    return '';
  }
}

/**
 * Normalize a URL to a resource key.
 * Strips query params, hashes, and trailing slashes.
 * Handles base URL and relative paths.
 *
 * The result is relative to the worker's scope, because that is the space
 * the manifest is keyed in: a build deployed under `<base href="/app/">`
 * still ships `main.dart.wasm`, not `app/main.dart.wasm`. Skipping the
 * re-basing does not merely lose cache hits — it silently disarms every
 * guard that matches on a key, including RESERVED_PATH_PREFIXES, which is
 * what keeps the host's own `/__/` namespace away from the app shell.
 */
export function getResourceKey(url: string, baseUrl?: string): string {
  try {
    const parsed = new URL(url, baseUrl ?? self.location.origin);
    let path = parsed.pathname;
    // Remove trailing slash (but keep root "/")
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    // Remove leading slash for consistency with manifest keys
    if (path.startsWith('/')) {
      path = path.slice(1);
    }
    // Re-base onto the worker's scope. The scope root itself arrives here
    // with its trailing slash already stripped, so it needs its own case.
    const scope = getScopePath();
    if (scope) {
      if (path.startsWith(scope)) {
        path = path.slice(scope.length);
      } else if (`${path}/` === scope) {
        path = '';
      }
      // A same-origin URL outside the scope is left alone: it will miss the
      // manifest and fall through to the network, which is what we want.
    }
    // Root path maps to index.html
    return path || 'index.html';
  } catch {
    return url;
  }
}

/**
 * Return a response that a browser will accept for a navigation.
 *
 * A response whose `redirected` flag is set cannot be replayed for a
 * request whose redirect mode is not "follow" — the browser rejects it and
 * the navigation fails outright. A shell fetched from a host that
 * normalizes `/index.html` to `/` is exactly that, so storing it verbatim
 * would turn every later offline navigation into an error page. Rebuilding
 * keeps the body, status and headers and drops only the flag.
 *
 * Only call this for responses that are already known to be `ok`.
 */
export async function replayableResponse(response: Response): Promise<Response> {
  if (!response.redirected) return response;
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Calculate exponential backoff delay for a given attempt.
 * @param attempt - Zero-based attempt index (0 = first retry)
 * @param baseDelay - Base delay in ms (default: RETRY_BASE_DELAY_MS)
 * @returns Delay in milliseconds with jitter
 */
export function backoffDelay(
  attempt: number,
  baseDelay = RETRY_BASE_DELAY_MS,
): number {
  const delay = baseDelay * Math.pow(2, attempt);
  // Add up to 20% jitter to prevent thundering herd
  const jitter = delay * 0.2 * Math.random();
  return delay + jitter;
}

/**
 * Append a cache-busting query parameter to a URL.
 */
export function cacheBustUrl(url: string, hash: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${hash}`;
}

/**
 * Fetch with timeout using AbortController.
 */
export async function fetchWithTimeout(
  request: Request,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolve with `fallback` if `promise` has not settled within `timeoutMs`.
 *
 * Callers use this to stop *waiting* on work, not to cancel it: the losing
 * promise keeps running, and a service worker registration abandoned this
 * way still installs in the background once the browser gets to it.
 *
 * A rejection that arrives before the deadline propagates; one that arrives
 * after it is discarded rather than left dangling, because `Promise.race`
 * stays subscribed to both sides.
 */
export async function withTimeout<T, F>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wrap a response so its body is cut off once it stops producing bytes for
 * `idleMs`, instead of hanging forever on a stalled stream.
 *
 * Erroring the transform cancels the source stream, which tears down the
 * underlying network transfer — no `AbortController` plumbing needed. The
 * consumer (`cache.put`) sees a rejected promise and reports a normal
 * precache failure, so a stalled body fails one install attempt rather than
 * wedging the scope's job queue forever.
 *
 * The timer is armed per chunk, so a slow-but-alive transfer is never cut:
 * only silence longer than `idleMs` is.
 *
 * Redirected responses are passed through untouched — their `redirected`
 * flag cannot survive being rebuilt, and `replayableResponse` needs to see
 * it to keep the shell replayable for navigations. They are small shell
 * documents, not the multi-megabyte payloads this guard exists for.
 */
export function guardBodyStall(response: Response, idleMs: number): Response {
  if (idleMs <= 0 || !response.body || response.redirected) return response;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    clear();
    timer = setTimeout(() => {
      try {
        controller.error(new Error(`Response body stalled for ${idleMs}ms`));
      } catch {
        // The consumer cancelled and the stream is already closed. There is
        // no `cancel` hook on a transformer to disarm the timer from, so
        // the last armed timer outlives the stream by up to `idleMs` and
        // lands here. Nothing to do: the transfer is over either way.
      }
    }, idleMs);
  };

  const guarded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start: arm,
      transform(chunk, controller) {
        arm(controller);
        controller.enqueue(chunk);
      },
      flush: clear,
    }),
  );

  return new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Run an array of async tasks with bounded concurrency.
 *
 * Precache can touch hundreds of files; without this limiter we'd burst
 * them all onto the network in one `Promise.all`, which browsers cap
 * anyway but which also risks triggering origin-side rate-limits and
 * burning RAM on buffered response clones.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;
  const size = Math.max(1, Math.min(limit, n));
  let cursor = 0;

  async function run(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= n) return;
      results[i] = await worker(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: size }, run));
  return results;
}

/**
 * Fetch with exponential backoff retry.
 */
export async function fetchWithRetry(
  request: Request,
  maxAttempts = MAX_RETRY_ATTEMPTS,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetchWithTimeout(request, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts - 1) {
        const delay = backoffDelay(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
