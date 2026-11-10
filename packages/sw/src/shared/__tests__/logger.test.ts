import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_LOG_LEVEL,
  getLogLevel,
  isLogLevel,
  log,
  setLogLevel,
  type LogLevel,
} from '../logger';

/**
 * Issue #38: a deployment must be able to turn the generated artifacts'
 * console output off. The level is module state, so each test puts it back.
 */
describe('logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setLogLevel(DEFAULT_LOG_LEVEL);
    vi.restoreAllMocks();
  });

  /** What each level lets through: [info, warn, error]. */
  const expected: Record<LogLevel, [boolean, boolean, boolean]> = {
    silent: [false, false, false],
    error: [false, false, true],
    warn: [false, true, true],
    info: [true, true, true],
  };

  it.each(Object.keys(expected) as LogLevel[])('level %s', (level) => {
    setLogLevel(level);
    log.info('i');
    log.warn('w');
    log.error('e');

    const [info, warn, error] = expected[level];
    expect(logSpy.mock.calls.length > 0).toBe(info);
    expect(warnSpy.mock.calls.length > 0).toBe(warn);
    expect(errorSpy.mock.calls.length > 0).toBe(error);
  });

  it('logs everything by default, as every release before the option', () => {
    expect(DEFAULT_LOG_LEVEL).toBe('info');
    expect(getLogLevel()).toBe('info');
  });

  it('passes every argument through, formatting included', () => {
    const error = new Error('boom');
    log.warn('%cstyled', 'color: red', error);
    expect(warnSpy).toHaveBeenCalledWith('%cstyled', 'color: red', error);
  });

  it('takes a level in any case, with surrounding space', () => {
    expect(setLogLevel('  SILENT ')).toBe('silent');
    log.error('e');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, null, ''])('leaves the level alone for %s', (value) => {
    setLogLevel('warn');
    expect(setLogLevel(value)).toBe('warn');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps the level and says so for a value it cannot read', () => {
    setLogLevel('warn');
    expect(setLogLevel('quiet')).toBe('warn');
    // On `console` itself: the level that decides whether a report is
    // printed is the one that could not be read.
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0]![0])).toContain('unknown logLevel');
  });

  it('reports an unreadable value even at silent', () => {
    setLogLevel('silent');
    setLogLevel(42);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('recognizes exactly the four names', () => {
    for (const level of ['silent', 'error', 'warn', 'info']) {
      expect(isLogLevel(level)).toBe(true);
    }
    for (const value of ['verbose', 'none', '', 0, null, undefined, {}]) {
      expect(isLogLevel(value)).toBe(false);
    }
  });
});
