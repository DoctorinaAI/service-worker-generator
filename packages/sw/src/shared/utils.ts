import {
  FETCH_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_AFTER_MAX_MS,
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
    // Decoded like the keys it is compared with in getResourceKey: under
    // `<base href="/my%20app/">` an encoded scope would match no key.
    const path = safeDecodeUri(new URL(scope).pathname);
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
    // `pathname` is percent-encoded, but the manifest is keyed by the file
    // names on disk: `assets/my photo.png` arrives as `my%20photo.png` and
    // would never match. `decodeURI` leaves escaped delimiters such as
    // `%2F` alone, so a decoded key cannot gain a path segment.
    let path = safeDecodeUri(parsed.pathname);
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

function safeDecodeUri(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    // A malformed escape (`%E0%A4%A`) is kept as sent.
    return path;
  }
}

/**
 * Whether [response] is an HTML page answering a request for a file that
 * is not one — the app shell a host with an SPA rewrite (Firebase,
 * Netlify, `try_files … /index.html`) returns with status 200 for a path
 * it does not have. Stored under a script's or an image's key, it is
 * served cache-first until the next deploy, and the app cannot start.
 */
export function isHtmlFallback(key: string, response: Response): boolean {
  if (/\.html?$/i.test(key)) return false;
  const type = response.headers.get('Content-Type') ?? '';
  return type.toLowerCase().includes('text/html');
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
 * Thrown (or used to error a body stream) when a response body does not
 * have the byte length the manifest recorded for it. The message names the
 * key and both sizes, so the precache / lazy-cache log line is enough to
 * tell a truncating proxy from a stale manifest.
 */
export class BodySizeMismatchError extends Error {
  constructor(
    readonly label: string,
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      `Size mismatch for ${label}: expected ${expected} bytes, ` +
        `received ${received}${received > expected ? '+' : ''}`,
    );
    this.name = 'BodySizeMismatchError';
  }
}

/** Options for [guardBody]. */
export interface BodyGuardOptions {
  /** Cut the body off after this much silence; `<= 0` disables. */
  idleMs?: number;
  /**
   * Exact byte length the body must have. Anything that is not a
   * non-negative integer (missing, NaN, negative, fractional) disables the
   * check, so a manifest entry without a usable size is stored as before.
   */
  expectedBytes?: number;
  /** Name used in error messages, normally the manifest key. */
  label?: string;
  /**
   * Called with the mismatch before the stream errors. The consumer cannot
   * rely on seeing the error itself: `cache.put` may reject with a generic
   * `TypeError` for a body that errored, losing the sizes and the type.
   */
  onMismatch?: (error: BodySizeMismatchError) => void;
}

function isByteCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * The body length an uncompressed response declares in `Content-Length`,
 * or `undefined` when it declares none, a malformed one, zero, or the
 * transfer is compressed (the header then counts the encoded bytes, while
 * the body is read decoded).
 *
 * A host that re-encodes a file (image optimisation, an injected snippet)
 * serves a different size than the build but declares it; a transfer that
 * is cut short cannot reach the declared length. Zero is not trusted: an
 * empty answer for a non-empty file is never what the build meant.
 */
export function declaredBodyLength(response: Response): number | undefined {
  const encoding = response.headers.get('Content-Encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') return undefined;
  const raw = response.headers.get('Content-Length')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length > 0 ? length : undefined;
}

/**
 * Wrap a response so its body is cut off once it stops producing bytes for
 * `idleMs`, and/or fails unless it has exactly `expectedBytes` bytes.
 *
 * Both checks run in one streaming transform: the body is never buffered,
 * only counted, so a 30 MB `main.dart.wasm` costs no extra memory. A failed
 * check errors the stream, which the consumer (`cache.put`) sees as a
 * rejected promise — the Cache API stores nothing for a body that errored —
 * and which cancels the source, tearing down the network transfer.
 *
 * The stall timer is armed per chunk, so a slow-but-alive transfer is never
 * cut: only silence longer than `idleMs` is. A body longer than expected is
 * failed as soon as it crosses the limit; a shorter one when it ends.
 *
 * Whenever the body is wrapped, the result is a rebuilt `Response` with the
 * original status, statusText and headers. A rebuilt response carries no
 * `redirected` flag, which is what lets a redirected shell be replayed for
 * a navigation — so redirected responses are guarded like any other, not
 * passed through and later buffered whole.
 *
 * When an uncompressed response declares a `Content-Length` other than
 * `expectedBytes`, the body is checked against the declared length instead,
 * with a warning: the host re-encoded the file but sends all of it, and a
 * transfer cut short still fails (see [declaredBodyLength]).
 *
 * A null body is treated as zero bytes: with a non-zero `expectedBytes` this
 * throws [BodySizeMismatchError] synchronously.
 */
export function guardBody(
  response: Response,
  options: BodyGuardOptions,
): Response {
  const idleMs = options.idleMs ?? 0;
  const label = options.label || response.url || 'response';
  let expected = isByteCount(options.expectedBytes)
    ? options.expectedBytes
    : undefined;
  if (expected !== undefined && response.body) {
    const declared = declaredBodyLength(response);
    if (declared !== undefined && declared !== expected) {
      console.warn(
        `[SW] ${label}: the host declares Content-Length ${declared} where ` +
          `the build has ${expected} bytes (re-encoded or rewritten by the ` +
          `host?); checking the transfer against the declared length.`,
      );
      expected = declared;
    }
  }
  if (idleMs <= 0 && expected === undefined) return response;
  const mismatch = (received: number): BodySizeMismatchError => {
    const error = new BodySizeMismatchError(label, expected!, received);
    try {
      options.onMismatch?.(error);
    } catch {
      // A diagnostics hook must not change what the guard does.
    }
    return error;
  };

  const init: ResponseInit = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };

  if (!response.body) {
    if (expected !== undefined && expected !== 0) {
      throw mismatch(0);
    }
    return response.redirected ? new Response(null, init) : response;
  }

  let received = 0;
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
    if (idleMs <= 0) return;
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
        received += chunk.byteLength;
        if (expected !== undefined && received > expected) {
          clear();
          throw mismatch(received);
        }
        arm(controller);
        controller.enqueue(chunk);
      },
      flush() {
        clear();
        if (expected !== undefined && received !== expected) {
          throw mismatch(received);
        }
      },
    }),
  );

  return new Response(guarded, init);
}

/**
 * Wrap a response so its body is cut off once it stops producing bytes for
 * `idleMs`, instead of hanging forever on a stalled stream. See [guardBody].
 */
export function guardBodyStall(response: Response, idleMs: number): Response {
  return guardBody(response, { idleMs });
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
 * Whether an HTTP status is worth retrying: a server error (5xx) or rate
 * limiting (429). Every other status, 4xx included, is a final answer.
 */
export function isRetriableStatus(status: number): boolean {
  return (status >= 500 && status <= 599) || status === 429;
}

/**
 * Delay a `Retry-After` header asks for, in ms, capped at `capMs`. Only the
 * delta-seconds form is honoured; an HTTP-date, a missing or a malformed
 * value yields `null` (use the regular backoff).
 */
export function retryAfterDelay(
  response: Response,
  capMs = RETRY_AFTER_MAX_MS,
): number | null {
  const raw = response.headers.get('Retry-After')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Math.min(Number(raw) * 1000, capMs);
}

/** Options for [fetchWithRetry]. */
export interface RetryOptions {
  /**
   * Also retry responses whose status [isRetriableStatus] accepts, waiting
   * for a numeric `Retry-After` (capped) or the regular backoff. The last
   * attempt's response is returned as is, so the caller still sees the
   * status. Off by default: navigations keep their existing behaviour.
   */
  retryOnStatus?: boolean;
}

/**
 * Fetch with exponential backoff retry.
 *
 * Thrown errors (network failures, timeouts) are always retried. Responses
 * are returned as they are unless `retryOnStatus` is set.
 */
export async function fetchWithRetry(
  request: Request,
  maxAttempts = MAX_RETRY_ATTEMPTS,
  timeoutMs = FETCH_TIMEOUT_MS,
  options: RetryOptions = {},
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const last = attempt >= maxAttempts - 1;
    let delay: number;
    try {
      const response = await fetchWithTimeout(request, timeoutMs);
      if (last || !options.retryOnStatus || !isRetriableStatus(response.status)) {
        return response;
      }
      delay = retryAfterDelay(response) ?? backoffDelay(attempt);
      console.warn(
        `[SW] HTTP ${response.status} for ${request.url}, retrying in ` +
          `${Math.round(delay)}ms (attempt ${attempt + 2}/${maxAttempts})`,
      );
      // Release the connection; the body of an error page is not needed.
      try {
        response.body?.cancel().catch(() => undefined);
      } catch {
        // A locked or already-consumed body: nothing to release.
      }
    } catch (error) {
      lastError = error;
      if (last) break;
      delay = backoffDelay(attempt);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw lastError;
}
