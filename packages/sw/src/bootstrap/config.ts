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
    ui: {
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
    },
  };
}
