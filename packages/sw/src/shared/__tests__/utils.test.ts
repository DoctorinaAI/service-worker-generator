/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatBytes,
  getResourceKey,
  getScopePath,
  backoffDelay,
  cacheBustUrl,
  fetchWithTimeout,
  fetchWithRetry,
  guardBody,
  guardBodyStall,
  isHtmlFallback,
  isRetriableStatus,
  retryAfterDelay,
  withTimeout,
} from '../utils';
import { installMockFetch, textResponse } from '../../__tests__/helpers';

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(5242880)).toBe('5 MB');
  });

  it('respects decimal precision', () => {
    expect(formatBytes(1536, 0)).toBe('2 KB');
    expect(formatBytes(1536, 2)).toBe('1.5 KB');
  });
});

describe('getResourceKey', () => {
  const origin = self.location.origin;

  it('strips query params', () => {
    expect(getResourceKey(`${origin}/main.dart.js?v=abc123`))
      .toBe('main.dart.js');
  });

  it('strips hash fragment', () => {
    expect(getResourceKey(`${origin}/app.js#section`))
      .toBe('app.js');
  });

  it('removes trailing slash', () => {
    expect(getResourceKey(`${origin}/path/`))
      .toBe('path');
  });

  it('decodes percent-escapes so keys match the file names on disk', () => {
    expect(getResourceKey(`${origin}/assets/my%20photo.png`))
      .toBe('assets/my photo.png');
    expect(getResourceKey(`${origin}/assets/%D1%84%D0%BE%D1%82%D0%BE.png`))
      .toBe('assets/фото.png');
  });

  it('keeps an escaped slash escaped, so decoding adds no path segment', () => {
    expect(getResourceKey(`${origin}/a%2Fb.png`)).toBe('a%2Fb.png');
  });

  it('keeps a malformed escape as sent', () => {
    expect(getResourceKey(`${origin}/bad%E0%A4%A.png`)).toBe('bad%E0%A4%A.png');
  });

  it('maps root to index.html', () => {
    expect(getResourceKey(`${origin}/`))
      .toBe('index.html');
  });

  it('handles nested paths', () => {
    expect(getResourceKey(`${origin}/assets/fonts/Roboto.ttf`))
      .toBe('assets/fonts/Roboto.ttf');
  });

  it('handles relative paths', () => {
    expect(getResourceKey('main.dart.js'))
      .toBe('main.dart.js');
  });
});

describe('getScopePath', () => {
  const origin = self.location.origin;
  const target = self as unknown as { registration?: unknown };

  afterEach(() => {
    delete target.registration;
  });

  it('is empty outside a service worker and at the origin root', () => {
    expect(getScopePath()).toBe('');
    target.registration = { scope: `${origin}/` };
    expect(getScopePath()).toBe('');
  });

  it('returns the scope path with its trailing slash', () => {
    target.registration = { scope: `${origin}/app/` };
    expect(getScopePath()).toBe('app/');
    expect(getResourceKey(`${origin}/app/main.dart.js`)).toBe('main.dart.js');
    expect(getResourceKey(`${origin}/app/`)).toBe('index.html');
  });

  it('re-bases keys under a percent-encoded scope', () => {
    // `<base href="/my app/">`: the scope arrives encoded, request paths are
    // decoded before the comparison, so both must be.
    target.registration = { scope: `${origin}/my%20app/` };
    expect(getScopePath()).toBe('my app/');
    expect(getResourceKey(`${origin}/my%20app/main.dart.js`)).toBe('main.dart.js');
    expect(getResourceKey(`${origin}/my%20app/__/auth/handler`)).toBe('__/auth/handler');
    expect(getResourceKey(`${origin}/my%20app/`)).toBe('index.html');
  });

  it('falls back to the origin root for a scope that does not parse', () => {
    // Keys then stay origin-relative instead of the lookup throwing.
    target.registration = { scope: 'not a url' };
    expect(getScopePath()).toBe('');
    expect(getResourceKey(`${origin}/app/main.dart.js`)).toBe('app/main.dart.js');
  });
});

describe('backoffDelay', () => {
  it('returns base delay for attempt 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelay(0, 1000)).toBe(1000);
    vi.restoreAllMocks();
  });

  it('doubles delay for each attempt', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelay(0, 1000)).toBe(1000);
    expect(backoffDelay(1, 1000)).toBe(2000);
    expect(backoffDelay(2, 1000)).toBe(4000);
    vi.restoreAllMocks();
  });

  it('adds jitter up to 20%', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1); // max jitter
    const delay = backoffDelay(0, 1000);
    expect(delay).toBe(1200); // 1000 + 20%
    vi.restoreAllMocks();
  });

  it('uses RETRY_BASE_DELAY_MS as default base', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const delay = backoffDelay(0);
    expect(delay).toBe(1000); // RETRY_BASE_DELAY_MS = 1000
    vi.restoreAllMocks();
  });
});

describe('cacheBustUrl', () => {
  it('appends hash as query param', () => {
    expect(cacheBustUrl('main.dart.js', 'abc123'))
      .toBe('main.dart.js?v=abc123');
  });

  it('uses & when URL already has query params', () => {
    expect(cacheBustUrl('app.js?mode=release', 'def456'))
      .toBe('app.js?mode=release&v=def456');
  });

  it('handles empty hash', () => {
    expect(cacheBustUrl('file.js', ''))
      .toBe('file.js?v=');
  });
});

describe('formatBytes edge cases', () => {
  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('rounds when decimals is negative (clamped to 0)', () => {
    expect(formatBytes(1536, -2)).toBe('2 KB');
  });

  it('supports multiple decimals beyond one', () => {
    expect(formatBytes(1234, 3)).toBe('1.205 KB');
  });
});

describe('getResourceKey edge cases', () => {
  const origin = self.location.origin;

  it('returns input unchanged when URL parsing fails', () => {
    expect(getResourceKey('http://:bad')).toBe('http://:bad');
  });

  it('handles URL objects built from bases', () => {
    expect(getResourceKey('/main.dart.js', origin)).toBe('main.dart.js');
  });

  it('accepts baseUrl override', () => {
    expect(getResourceKey('/foo/bar', 'https://example.com'))
      .toBe('foo/bar');
  });

  it('keeps a deep path with multiple segments', () => {
    expect(getResourceKey(`${origin}/a/b/c/d.wasm`))
      .toBe('a/b/c/d.wasm');
  });
});

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns response when fetch resolves before the timeout', async () => {
    installMockFetch(async () => textResponse('ok'));
    const response = await fetchWithTimeout(
      new Request('http://example.com/x'),
      1_000,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('aborts fetch when the timeout fires', async () => {
    let abortSignalled = false;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            abortSignalled = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      },
    ) as unknown as typeof fetch;

    const promise = fetchWithTimeout(
      new Request('http://example.com/slow'),
      5,
    );
    await expect(promise).rejects.toThrow();
    expect(abortSignalled).toBe(true);
  });

  it('passes the same request object through to fetch', async () => {
    const spy = installMockFetch(async () => textResponse('hi'));
    const req = new Request('http://example.com/x');
    await fetchWithTimeout(req, 1_000);
    expect(spy).toHaveBeenCalledTimes(1);
    const firstArg = spy.mock.calls[0][0] as Request;
    expect(firstArg.url).toBe(req.url);
  });
});

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the first successful response', async () => {
    const spy = installMockFetch(async () => textResponse('ok'));
    const res = await fetchWithRetry(
      new Request('http://example.com/x'),
      3,
      1_000,
    );
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries on network failure and eventually succeeds', async () => {
    let attempts = 0;
    const spy = installMockFetch(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('network');
      return textResponse('ok');
    });
    // Override backoff to be instant for fast test.
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);

    const res = await fetchWithRetry(
      new Request('http://example.com/x'),
      3,
      1_000,
    );
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    installMockFetch(async () => {
      throw new Error('down');
    });
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);

    await expect(
      fetchWithRetry(new Request('http://example.com/x'), 2, 1_000),
    ).rejects.toThrow('down');
  });

  it('returns non-ok response without retry (fetchWithRetry does not probe response.ok)', async () => {
    const spy = installMockFetch(async () => textResponse('boom', 500));
    const res = await fetchWithRetry(
      new Request('http://example.com/x'),
      3,
      1_000,
    );
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the promise value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('v'), 1_000, 'fallback')).resolves.toBe('v');
  });

  it('resolves with the fallback when the promise never settles', async () => {
    vi.useFakeTimers();
    const promise = withTimeout(new Promise<string>(() => {}), 1_000, 'fallback');
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(promise).resolves.toBe('fallback');
  });

  it('propagates a rejection that arrives before the deadline', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1_000, 'fallback'),
    ).rejects.toThrow('boom');
  });
});

describe('guardBodyStall', () => {
  /** A body that emits `chunks` spaced `gapMs` apart, then closes. */
  function pacedBody(chunks: string[], gapMs: number): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it('passes the body through untouched when disabled', () => {
    const response = new Response('body');
    expect(guardBodyStall(response, 0)).toBe(response);
  });

  it('guards a redirected body too, and drops the redirected flag', async () => {
    // A host that redirects every path (S3, `www` normalisation) used to
    // get its bodies passed through unguarded and then buffered whole.
    const response = new Response('body', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html' },
    });
    Object.defineProperty(response, 'redirected', { value: true });
    const guarded = guardBodyStall(response, 50);
    expect(guarded).not.toBe(response);
    expect(guarded.redirected).toBe(false);
    expect(guarded.status).toBe(200);
    expect(guarded.statusText).toBe('OK');
    expect(guarded.headers.get('content-type')).toBe('text/html');
    await expect(guarded.text()).resolves.toBe('body');
  });

  it('errors a redirected body that stalls', async () => {
    const stalled = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
        },
      }),
      { status: 200 },
    );
    Object.defineProperty(stalled, 'redirected', { value: true });
    await expect(guardBodyStall(stalled, 30).text()).rejects.toThrow(/stalled/);
  });

  it('delivers a complete body unchanged', async () => {
    const guarded = guardBodyStall(pacedBody(['a', 'b', 'c'], 1), 500);
    await expect(guarded.text()).resolves.toBe('abc');
  });

  it('leaves a slow but alive stream alone', async () => {
    // Five gaps of 10ms each: far longer in total than the 40ms idle
    // threshold, but never silent for that long. A connection that is
    // merely slow must be allowed to finish.
    const guarded = guardBodyStall(pacedBody(['a', 'b', 'c', 'd', 'e'], 10), 40);
    await expect(guarded.text()).resolves.toBe('abcde');
  });

  it('errors a body that goes silent past the threshold', async () => {
    const stalled = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          // ...and then nothing, ever. This is the shape that hangs
          // cache.put, and with it the whole install.
        },
      }),
      { status: 200 },
    );

    await expect(guardBodyStall(stalled, 30).text()).rejects.toThrow(
      /stalled for 30ms/,
    );
  });

  it('preserves status and headers', () => {
    const response = new Response('body', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/javascript' },
    });
    const guarded = guardBodyStall(response, 50);
    expect(guarded.status).toBe(200);
    expect(guarded.headers.get('content-type')).toBe('application/javascript');
  });
});

describe('isHtmlFallback', () => {
  const html = (type: string): Response =>
    new Response('<!DOCTYPE html>', { headers: { 'Content-Type': type } });

  it('flags an HTML page served for a script, wasm or image', () => {
    expect(isHtmlFallback('main.dart.js', html('text/html; charset=utf-8'))).toBe(true);
    expect(isHtmlFallback('main.dart.wasm', html('TEXT/HTML'))).toBe(true);
    expect(isHtmlFallback('assets/logo.png', html('text/html'))).toBe(true);
  });

  it('accepts HTML for an HTML file', () => {
    expect(isHtmlFallback('index.html', html('text/html'))).toBe(false);
    expect(isHtmlFallback('legal/terms.htm', html('text/html'))).toBe(false);
  });

  it('accepts the right type, and a response with no type at all', () => {
    expect(isHtmlFallback('main.dart.js', html('text/javascript'))).toBe(false);
    expect(isHtmlFallback('main.dart.js', new Response(new Uint8Array([1])))).toBe(false);
  });
});

describe('guardBody size check', () => {
  const bytes = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(7);

  /** A body delivered in the given chunk sizes. */
  function chunked(sizes: number[]): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const n of sizes) controller.enqueue(bytes(n));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }

  it('passes a body whose length matches', async () => {
    const guarded = guardBody(chunked([3, 4, 5]), { expectedBytes: 12, label: 'a.js' });
    expect((await guarded.arrayBuffer()).byteLength).toBe(12);
  });

  it('errors a truncated body, naming the key and both sizes', async () => {
    const guarded = guardBody(chunked([3, 4]), { expectedBytes: 12, label: 'main.dart.wasm' });
    await expect(guarded.arrayBuffer()).rejects.toThrow(
      /main\.dart\.wasm.*expected 12 bytes.*received 7/,
    );
  });

  it('errors an oversized body as soon as it passes the expected size', async () => {
    const guarded = guardBody(chunked([10, 10]), { expectedBytes: 12, label: 'a.js' });
    await expect(guarded.arrayBuffer()).rejects.toThrow(/expected 12 bytes.*received 20/);
  });

  it('accepts an empty body for a zero-size entry', async () => {
    const guarded = guardBody(chunked([]), { expectedBytes: 0, label: 'empty.json' });
    expect((await guarded.arrayBuffer()).byteLength).toBe(0);
  });

  it('accepts a null body for a zero-size entry', () => {
    const response = new Response(null, { status: 200 });
    expect(() => guardBody(response, { expectedBytes: 0, label: 'x' })).not.toThrow();
  });

  it('rejects a null body for a non-empty entry', () => {
    const response = new Response(null, { status: 200 });
    expect(() => guardBody(response, { expectedBytes: 5, label: 'x.js' })).toThrow(
      /x\.js.*expected 5 bytes.*received 0/,
    );
  });

  it('skips the check when the size is unknown', async () => {
    for (const expectedBytes of [undefined, Number.NaN, -1, 1.5]) {
      const guarded = guardBody(chunked([3]), { expectedBytes, label: 'x' });
      expect((await guarded.arrayBuffer()).byteLength).toBe(3);
    }
  });

  it('returns the response itself when there is nothing to guard', () => {
    const response = new Response('body');
    expect(guardBody(response, {})).toBe(response);
  });

  /** [chunked] with response headers. */
  function withHeaders(sizes: number[], headers: Record<string, string>): Response {
    const base = chunked(sizes);
    return new Response(base.body, { status: 200, headers });
  }

  it('accepts a complete body of the length the host declares, with a warning', async () => {
    // A host that re-encodes the file (image optimisation, an injected
    // snippet) sends a different file, but sends all of it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const guarded = guardBody(withHeaders([4, 4], { 'Content-Length': '8' }), {
        expectedBytes: 12,
        label: 'logo.png',
      });
      expect((await guarded.arrayBuffer()).byteLength).toBe(8);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toMatch(
        /logo\.png.*Content-Length 8.*build has 12/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('still errors a body cut short of the declared length', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const guarded = guardBody(withHeaders([4], { 'Content-Length': '8' }), {
        expectedBytes: 12,
        label: 'logo.png',
      });
      await expect(guarded.arrayBuffer()).rejects.toThrow(/received 4/);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores Content-Length on a compressed transfer', async () => {
    // The declared length is the compressed size; the body is decoded.
    const guarded = guardBody(
      withHeaders([4, 4], { 'Content-Length': '8', 'Content-Encoding': 'gzip' }),
      { expectedBytes: 12, label: 'a.js' },
    );
    await expect(guarded.arrayBuffer()).rejects.toThrow(/expected 12 bytes.*received 8/);
  });

  it('ignores a zero or malformed Content-Length', async () => {
    for (const value of ['0', 'abc', '-5', '8, 8']) {
      const guarded = guardBody(withHeaders([4, 4], { 'Content-Length': value }), {
        expectedBytes: 12,
        label: 'a.js',
      });
      await expect(guarded.arrayBuffer()).rejects.toThrow(/expected 12 bytes/);
    }
  });
});

describe('fetchWithRetry with retryOnStatus', () => {
  let delays: number[];

  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    delays = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      return origSetTimeout(fn, 0);
    }) as unknown as typeof setTimeout);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const req = (): Request => new Request('http://example.com/main.dart.wasm');

  it('retries a 503 and returns the later success', async () => {
    let n = 0;
    const spy = installMockFetch(async () => (++n < 3 ? textResponse('busy', 503) : textResponse('ok')));
    const res = await fetchWithRetry(req(), 3, 1_000, { retryOnStatus: true });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('retries a 429', async () => {
    let n = 0;
    const spy = installMockFetch(async () => (++n < 2 ? textResponse('slow down', 429) : textResponse('ok')));
    const res = await fetchWithRetry(req(), 3, 1_000, { retryOnStatus: true });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns the last 5xx once the attempts are exhausted', async () => {
    const spy = installMockFetch(async () => textResponse('down', 502));
    const res = await fetchWithRetry(req(), 3, 1_000, { retryOnStatus: true });
    expect(res.status).toBe(502);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404', async () => {
    const spy = installMockFetch(async () => textResponse('gone', 404));
    const res = await fetchWithRetry(req(), 3, 1_000, { retryOnStatus: true });
    expect(res.status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('honours a numeric Retry-After, capped', async () => {
    let n = 0;
    installMockFetch(async () => {
      n += 1;
      if (n === 1) return new Response('', { status: 503, headers: { 'Retry-After': '2' } });
      if (n === 2) return new Response('', { status: 503, headers: { 'Retry-After': '3600' } });
      return textResponse('ok');
    });
    await fetchWithRetry(req(), 3, 7_777, { retryOnStatus: true });
    // The timeout timer of each attempt is also recorded (7_777 here).
    const waits = delays.filter((d) => d !== 7_777);
    expect(waits).toEqual([2_000, 5_000]);
  });

  it('falls back to the backoff for a date or garbage Retry-After', async () => {
    let n = 0;
    installMockFetch(async () => {
      n += 1;
      if (n === 1) {
        return new Response('', {
          status: 503,
          headers: { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' },
        });
      }
      return textResponse('ok');
    });
    await fetchWithRetry(req(), 3, 7_777, { retryOnStatus: true });
    expect(delays.filter((d) => d !== 7_777)).toEqual([1_000]);
  });

  it('keeps the old behaviour without the option', async () => {
    const spy = installMockFetch(async () => textResponse('down', 503));
    const res = await fetchWithRetry(req(), 3, 1_000);
    expect(res.status).toBe(503);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('isRetriableStatus / retryAfterDelay', () => {
  it('classifies statuses', () => {
    for (const s of [500, 502, 503, 504, 599, 429]) expect(isRetriableStatus(s)).toBe(true);
    for (const s of [200, 301, 400, 401, 403, 404, 410, 499, 600]) {
      expect(isRetriableStatus(s)).toBe(false);
    }
  });

  it('parses Retry-After seconds only', () => {
    const r = (v: string): Response => new Response('', { status: 503, headers: { 'Retry-After': v } });
    expect(retryAfterDelay(r('0'), 5_000)).toBe(0);
    expect(retryAfterDelay(r(' 4 '), 5_000)).toBe(4_000);
    expect(retryAfterDelay(r('10'), 5_000)).toBe(5_000);
    expect(retryAfterDelay(r('-1'), 5_000)).toBeNull();
    expect(retryAfterDelay(r('1.5'), 5_000)).toBeNull();
    expect(retryAfterDelay(r('soon'), 5_000)).toBeNull();
    expect(retryAfterDelay(new Response('', { status: 503 }), 5_000)).toBeNull();
  });
});
