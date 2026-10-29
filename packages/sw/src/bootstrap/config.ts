import type { BootstrapConfig, BuildConfig } from '../shared/types';
import { DEFAULT_MIN_PROGRESS, DEFAULT_MAX_PROGRESS } from '../shared/constants';

/**
 * Merged configuration with all defaults applied.
 */
export interface ResolvedConfig {
  /** Build-time config injected by Dart CLI */
  build: BuildConfig;
  /** Runtime config from data-config + defaults */
  ui: Required<BootstrapConfig>;
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
  try {
    return JSON.parse(raw) as BootstrapConfig;
  } catch {
    console.warn('[Bootstrap] Invalid data-config JSON, using defaults');
    return {};
  }
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
  return {
    build: buildConfig,
    ui: normalizeUi({
      logo: userConfig.logo ?? d.logo ?? '',
      title: userConfig.title ?? d.title ?? '',
      theme: userConfig.theme ?? d.theme ?? 'auto',
      color: userConfig.color ?? d.color ?? '#25D366',
      showPercentage:
        userConfig.showPercentage ?? d.showPercentage ?? true,
      minProgress:
        userConfig.minProgress ?? d.minProgress ?? DEFAULT_MIN_PROGRESS,
      maxProgress:
        userConfig.maxProgress ?? d.maxProgress ?? DEFAULT_MAX_PROGRESS,
    }),
  };
}

const THEMES: ReadonlySet<string> = new Set(['light', 'dark', 'auto']);
const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX_6 = /^#[0-9a-f]{6}$/i;
const HEX_8 = /^#[0-9a-f]{8}$/i;

function warnConfig(message: string): void {
  console.warn(`[Bootstrap] Config: ${message}`);
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
function normalizeUi(ui: Required<BootstrapConfig>): Required<BootstrapConfig> {
  const raw = ui as Record<keyof BootstrapConfig, unknown>;

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

  // showPercentage: accept "true"/"false" strings ("false" is truthy).
  let showPercentage = ui.showPercentage;
  if (typeof raw.showPercentage !== 'boolean') {
    const key =
      typeof raw.showPercentage === 'string'
        ? raw.showPercentage.trim().toLowerCase()
        : '';
    showPercentage =
      key === 'true' ? true : key === 'false' ? false : Boolean(raw.showPercentage);
    warnConfig(
      `showPercentage ${JSON.stringify(raw.showPercentage)} is not a boolean, using ${showPercentage}`,
    );
  }

  // color: #rgb → #rrggbb; other formats are kept but cannot get alpha.
  let color = ui.color;
  if (typeof raw.color === 'string' && HEX_SHORT.test(raw.color)) {
    color = expandShortHex(raw.color);
  } else if (
    typeof raw.color !== 'string' ||
    !(HEX_6.test(raw.color) || HEX_8.test(raw.color))
  ) {
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

  return { ...ui, theme, showPercentage, color, minProgress, maxProgress };
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
