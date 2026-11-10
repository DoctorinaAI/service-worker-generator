/**
 * How much the generated artifacts say on the console.
 *
 * Both bundles log: the bootstrap prints a version banner, a phase line
 * per stage and a progress bar per update, and the worker prints its
 * manifest summary — useful while a deployment is being set up, noise once
 * it is in production, and noise an app embedded in someone else's page
 * cannot afford at all (issue #38).
 *
 * The level is a build-time setting (`--log-level`, baked into both
 * artifacts) that the page may override at runtime through the bootstrap's
 * `data-config`. It never changes *what* the code does, only what it says.
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info';

/** Levels in increasing verbosity, as a lookup. */
const RANK: Readonly<Record<LogLevel, number>> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
};

/** The default: everything, as every release before the option had. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

let rank = RANK[DEFAULT_LOG_LEVEL];
let current: LogLevel = DEFAULT_LOG_LEVEL;

/** Whether [value] is one of the four level names. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in RANK;
}

/**
 * Set the level from a value that may come from untyped JSON.
 *
 * An unknown value leaves the level alone and is reported — on `console`
 * directly, because the level that decides whether a report is printed is
 * the one that could not be read. Returns the level in force afterwards.
 */
export function setLogLevel(value: unknown): LogLevel {
  if (value === undefined || value === null || value === '') return current;
  const level = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (!isLogLevel(level)) {
    console.warn(
      `[Bootstrap] Config: unknown logLevel ${JSON.stringify(value)}; ` +
        `expected silent, error, warn or info, keeping ${current}`,
    );
    return current;
  }
  current = level;
  rank = RANK[level];
  return current;
}

/** The level in force. */
export function getLogLevel(): LogLevel {
  return current;
}

/**
 * Console output, gated by the level in force.
 *
 * `info` covers the running commentary (the banner, phases, progress),
 * `warn` the conditions a deployment may want to fix, `error` the ones that
 * broke something. Every call site of `console` in both bundles goes
 * through here, so `--log-level=silent` really is silent.
 */
export const log = {
  info(...args: unknown[]): void {
    if (rank >= RANK.info) console.log(...args);
  },
  warn(...args: unknown[]): void {
    if (rank >= RANK.warn) console.warn(...args);
  },
  error(...args: unknown[]): void {
    if (rank >= RANK.error) console.error(...args);
  },
};
