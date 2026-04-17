/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatBytes,
  getResourceKey,
  backoffDelay,
  cacheBustUrl,
  fetchWithTimeout,
  fetchWithRetry,
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
