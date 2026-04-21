import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logPhase, logProgress, logVersionBanner } from '../console-logger';
import type { BuildConfig } from '../../shared/types';

describe('logPhase', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('prints the phase label and message', () => {
    logPhase('Init', 'hello');
    expect(spy).toHaveBeenCalled();
    const args = spy.mock.calls[0];
    expect(String(args[0])).toContain('Init');
    expect(String(args[0])).toContain('hello');
  });

  it('uses two CSS style arguments (phase + info)', () => {
    logPhase('SW', 'ready');
    const args = spy.mock.calls[0];
    // First arg is the format string, followed by at least two style strings.
    expect(args.length).toBeGreaterThanOrEqual(3);
  });
});

describe('logProgress', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('rounds the percent value', () => {
    logProgress(37.6, 'downloading');
    const out = String(spy.mock.calls[0][0]);
    expect(out).toContain('38%');
  });

  it('renders a 20-char progress bar scaled to the percent', () => {
    logProgress(50, 'half');
    const out = String(spy.mock.calls[0][0]);
    // 20-wide bar, 50% → 10 filled + 10 empty blocks.
    const fillCount = (out.match(/\u2588/g) ?? []).length;
    const emptyCount = (out.match(/\u2591/g) ?? []).length;
    expect(fillCount).toBe(10);
    expect(emptyCount).toBe(10);
  });

  it('produces a fully-filled bar at 100%', () => {
    logProgress(100, 'done');
    const out = String(spy.mock.calls[0][0]);
    const fillCount = (out.match(/\u2588/g) ?? []).length;
    expect(fillCount).toBe(20);
  });

  it('produces an empty bar at 0%', () => {
    logProgress(0, 'start');
    const out = String(spy.mock.calls[0][0]);
    const emptyCount = (out.match(/\u2591/g) ?? []).length;
    expect(emptyCount).toBe(20);
  });
});

describe('logVersionBanner', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('includes SW version and a truncated engine revision', () => {
    const cfg: BuildConfig = {
      engineRevision: 'abcdef1234567890',
      swVersion: '42',
      swFilename: 'sw.js',
      builds: [{ renderer: 'canvaskit', compileTarget: 'dart2js' }],
    };
    logVersionBanner(cfg);
    const joined = spy.mock.calls[0].map(String).join(' ');
    expect(joined).toContain('42');
    expect(joined).toContain('abcdef1234');
    expect(joined).toContain('canvaskit');
    expect(joined).toContain('dart2js');
  });

  it('falls back to "unknown" when renderer/target are missing', () => {
    const cfg: BuildConfig = {
      engineRevision: 'rev',
      swVersion: '1',
      swFilename: 'sw.js',
      builds: [{}],
    };
    logVersionBanner(cfg);
    const joined = spy.mock.calls[0].map(String).join(' ');
    expect(joined).toContain('unknown');
  });
});
