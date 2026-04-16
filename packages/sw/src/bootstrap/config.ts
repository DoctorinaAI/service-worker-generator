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
 */
export function findBootstrapScript(): HTMLScriptElement | null {
  return document.getElementById('bootstrap') as HTMLScriptElement | null;
}

/**
 * Merge user config with defaults to produce a fully resolved config.
 */
export function resolveConfig(
  buildConfig: BuildConfig,
  userConfig: BootstrapConfig,
): ResolvedConfig {
  return {
    build: buildConfig,
    ui: {
      logo: userConfig.logo ?? '',
      title: userConfig.title ?? '',
      theme: userConfig.theme ?? 'auto',
      color: userConfig.color ?? '#25D366',
      showPercentage: userConfig.showPercentage ?? true,
      minProgress: userConfig.minProgress ?? DEFAULT_MIN_PROGRESS,
      maxProgress: userConfig.maxProgress ?? DEFAULT_MAX_PROGRESS,
    },
  };
}
