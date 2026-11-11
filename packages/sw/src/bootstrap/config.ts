import type { BootstrapConfig, BuildConfig } from '../shared/types';
import { DEFAULT_MIN_PROGRESS, DEFAULT_MAX_PROGRESS } from '../shared/constants';
import { log, setLogLevel } from '../shared/logger';
import { resolveStrings, type Strings } from '../shared/strings';

/**
 * The loading widget's settings, every one resolved.
 *
 * `logLevel` is not among them: it is applied to the logger rather than
 * rendered, so the widget never has to carry a setting it cannot use.
 */
export type ResolvedUi = Required<
  Omit<BootstrapConfig, 'logLevel' | 'strings'>
> & {
  /** Every string the loading screen shows, resolved. */
  strings: Strings;
};

/**
 * Merged configuration with all defaults applied.
 */
export interface ResolvedConfig {
  /** Build-time config injected by Dart CLI */
  build: BuildConfig;
  /** Runtime config from data-config + defaults */
  ui: ResolvedUi;
}

/**
 * Parse the data-config attribute from the bootstrap script tag.
 */
export function parseDataConfig(
  scriptElement: HTMLScriptElement | null,
): BootstrapConfig {
  if (!scriptElement) return {};
  const raw = scriptElement.dataset.config;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('[Bootstrap] Invalid data-config JSON, using defaults');
    return {};
  }
  // Valid JSON that is not an object — `null`, a number, an array — would
  // throw on the first property read and take the whole bootstrap with it.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('[Bootstrap] data-config is not a JSON object, using defaults');
    return {};
  }
  return parsed as BootstrapConfig;
}

/**
 * Find the bootstrap script element in the document.
 *
 * Uses a data-attribute selector instead of `id="bootstrap"`:
 * the latter leaks the script node as `window.bootstrap`, which
 * clashes with popular libraries (e.g. Bootstrap CSS).
 */
export function findBootstrapScript(): HTMLScriptElement | null {
  return document.querySelector(
    'script[data-sw-bootstrap]',
  ) as HTMLScriptElement | null;
}

/**
 * Merge user config with defaults to produce a fully resolved config.
 *
 * Precedence: data-config attribute > Dart CLI `uiDefaults` > hardcoded
 * fallbacks. This lets project owners bake brand defaults into
 * `bootstrap.js` at build time while still letting a given HTML page
 * override them per-deployment via the `data-config` attribute.
 */
export function resolveConfig(
  buildConfig: BuildConfig,
  userConfig: BootstrapConfig,
): ResolvedConfig {
  const d = buildConfig.uiDefaults ?? {};
  // Before the corrections below are reported: the level decides whether
  // they are heard. The build-time level is already in force (see
  // bootstrap/index.ts), so an absent or unusable override leaves it alone.
  setLogLevel(userConfig.logLevel);
  return {
    build: buildConfig,
    ui: normalizeUi({
      // Unknown keys and non-string values are dropped inside: this comes
      // from `data-config`, which is untyped JSON.
      strings: resolveStrings(userConfig.strings ?? d.strings),
      logo: userConfig.logo ?? d.logo ?? '',
      title: userConfig.title ?? d.title ?? '',
      theme: userConfig.theme ?? d.theme ?? 'auto',
      color: userConfig.color ?? d.color ?? DEFAULT_COLOR,
      showPercentage:
        userConfig.showPercentage ?? d.showPercentage ?? true,
      showWidget: userConfig.showWidget ?? d.showWidget ?? true,
      minProgress:
        userConfig.minProgress ?? d.minProgress ?? DEFAULT_MIN_PROGRESS,
      maxProgress:
        userConfig.maxProgress ?? d.maxProgress ?? DEFAULT_MAX_PROGRESS,
    }),
  };
}

const THEMES: ReadonlySet<string> = new Set(['light', 'dark', 'auto']);
/** The brand green the widget falls back to. */
const DEFAULT_COLOR = '#25D366';
/**
 * Characters that would end the CSS declaration a colour is written into,
 * or start a comment inside it. Quotes and backslashes too: an unclosed
 * string or an escape swallows the rest of the stylesheet. Parentheses are
 * allowed — `rgb()`, `hsl()` and `var()` are colours a page may
 * legitimately pass — but only balanced; see `isUnsafeColor`.
 */
const CSS_UNSAFE = /[;{}"'\\]|\/\*|<|>/;

/**
 * Whether [color] cannot be written into the widget's stylesheet as is.
 *
 * An unclosed `(` — `rgb(37, 211, 102` with its parenthesis lost — makes
 * the rest of the stylesheet part of one function, so every rule after the
 * ring's went with it, the hidden reload button among them.
 */
function isUnsafeColor(color: string): boolean {
  if (CSS_UNSAFE.test(color)) return true;
  let depth = 0;
  for (const char of color) {
    if (char === '(') depth++;
    else if (char === ')' && --depth < 0) return true;
  }
  return depth !== 0;
}
const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX_6 = /^#[0-9a-f]{6}$/i;
const HEX_8 = /^#[0-9a-f]{8}$/i;

/**
 * A boolean from `data-config`, which is untyped JSON: the string "false"
 * is truthy, and a page that writes `"showWidget": "false"` means the
 * opposite of what `Boolean()` would give it. Anything that is not a
 * boolean is corrected and warned about.
 */
function boolOption(name: string, raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const value = key === 'true' ? true : key === 'false' ? false : Boolean(raw);
  warnConfig(
    `${name} ${JSON.stringify(raw)} is not a boolean, using ${value}`,
  );
  return value;
}

function warnConfig(message: string): void {
  log.warn(`[Bootstrap] Config: ${message}`);
}

/**
 * Expand `#rgb` / `#rgba` to `#rrggbb` / `#rrggbbaa`; any other value is
 * returned unchanged.
 */
function expandShortHex(color: string): string {
  const m = HEX_SHORT.exec(color);
  if (!m) return color;
  return '#' + m.slice(1).filter(Boolean).map((c) => c + c).join('');
}

/**
 * Derive a translucent variant of [color] for glows and pulses.
 *
 * Hex colors get [alphaHex] as their alpha channel, replacing one they
 * already carry. Other formats (`rgb()`, names) keep the old plain
 * concatenation, which the browser drops as invalid, as it always did.
 */
export function withAlpha(color: string, alphaHex: string): string {
  const hex = expandShortHex(color);
  if (HEX_6.test(hex)) return hex + alphaHex;
  if (HEX_8.test(hex)) return hex.slice(0, 7) + alphaHex;
  return `${color}${alphaHex}`;
}

/**
 * Correct values that `data-config` (untyped JSON) or older generators may
 * deliver in a shape the widget cannot use. Every correction is warned
 * about; values that are already valid pass through unchanged.
 */
function normalizeUi(ui: ResolvedUi): ResolvedUi {
  const raw = ui as Record<keyof ResolvedUi, unknown>;

  // theme: case-insensitive; anything else renders light, as before.
  let theme = ui.theme;
  const themeKey =
    typeof raw.theme === 'string' ? raw.theme.trim().toLowerCase() : '';
  if (THEMES.has(themeKey)) {
    theme = themeKey as typeof ui.theme;
  } else {
    warnConfig(
      `unknown theme ${JSON.stringify(raw.theme)}; expected light, dark or auto, using light`,
    );
    theme = 'light';
  }

  // showPercentage and showWidget: accept "true"/"false" strings, since
  // `data-config` is untyped JSON and "false" is truthy.
  const showPercentage = boolOption('showPercentage', raw.showPercentage);
  const showWidget = boolOption('showWidget', raw.showWidget);

  // color: #rgb → #rrggbb; other formats are kept but cannot get alpha.
  let color = ui.color;
  if (typeof raw.color === 'string' && HEX_SHORT.test(raw.color)) {
    color = expandShortHex(raw.color);
  } else if (typeof raw.color !== 'string') {
    // Not a string at all — `{"color": 16711680}` is a common mistake in
    // `data-config`, which is untyped JSON. Everything downstream treats
    // it as one: the contrast correction calls `.trim()` on it and throws,
    // and a stylesheet that throws leaves the page with no loading screen
    // and no error screen either.
    color = DEFAULT_COLOR;
    warnConfig(
      `color ${JSON.stringify(raw.color)} is not a string, using ${DEFAULT_COLOR}`,
    );
  } else if (isUnsafeColor(raw.color)) {
    // The value is interpolated into the widget's stylesheet. One
    // carrying `;` or `}` closes the declaration and corrupts every rule
    // after it — a loading screen that renders as unstyled text, from a
    // single stray character.
    color = DEFAULT_COLOR;
    warnConfig(
      `color ${JSON.stringify(raw.color)} is not a usable CSS colour, ` +
        `using ${DEFAULT_COLOR}`,
    );
  } else if (!(HEX_6.test(raw.color) || HEX_8.test(raw.color))) {
    warnConfig(
      `color ${JSON.stringify(raw.color)} is not #rgb, #rrggbb or #rrggbbaa; ` +
        'glow and pulse effects may not render',
    );
  }

  let minProgress = progressBound('minProgress', raw.minProgress, DEFAULT_MIN_PROGRESS);
  let maxProgress = progressBound('maxProgress', raw.maxProgress, DEFAULT_MAX_PROGRESS);
  if (minProgress > maxProgress) {
    warnConfig(
      `minProgress ${minProgress} > maxProgress ${maxProgress}, swapping them`,
    );
    [minProgress, maxProgress] = [maxProgress, minProgress];
  }

  return {
    ...ui,
    theme,
    showPercentage,
    showWidget,
    color,
    minProgress,
    maxProgress,
  };
}

function progressBound(name: string, value: unknown, fallback: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) {
    warnConfig(`${name} ${JSON.stringify(value)} is not a number, using ${fallback}`);
    return fallback;
  }
  if (typeof value === 'string') {
    warnConfig(`${name} given as a string ${JSON.stringify(value)}, using ${n}`);
  }
  const clamped = Math.min(100, Math.max(0, n));
  if (clamped !== n) {
    warnConfig(`${name} ${n} is outside 0..100, using ${clamped}`);
  }
  return clamped;
}
