/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { formatBytes, getResourceKey, backoffDelay, cacheBustUrl } from '../utils';

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
