/**
 * Resource category determining caching behavior.
 */
export enum ResourceCategory {
  /** Essential for app startup: canvaskit, main.dart.js/wasm */
  Core = 'core',
  /** Needed early: AssetManifest, FontManifest */
  Required = 'required',
  /** Lightweight files cached lazily on first fetch */
  Optional = 'optional',
  /** Large assets, debug files — not cached */
  Ignore = 'ignore',
}

/**
 * A single resource entry in the manifest.
 */
export interface ResourceEntry {
  /** File basename, e.g., "main.dart.js" */
  name: string;
  /** File size in bytes */
  size: number;
  /** MD5 hash for cache busting */
  hash: string;
  /** Caching category */
  category: ResourceCategory;
}

/**
 * Resource manifest: path → entry metadata.
 */
export type ResourceManifest = Record<string, ResourceEntry>;

/**
 * Service Worker configuration injected at generation time.
 */
export interface SWConfig {
  /** Cache name prefix, e.g., "my-app" */
  cachePrefix: string;
  /** Cache version string, e.g., timestamp */
  version: string;
  /** Resource manifest */
  manifest: ResourceManifest;
}

/**
 * Bootstrap configuration from data-config attribute.
 */
export interface BootstrapConfig {
  /** Path to logo image */
  logo?: string;
  /** Title text for loading widget */
  title?: string;
  /** Theme: "light" | "dark" | "auto" */
  theme?: 'light' | 'dark' | 'auto';
  /** Accent color for progress ring */
  color?: string;
  /** Show numeric percentage */
  showPercentage?: boolean;
  /** Minimum progress value (default: 0) */
  minProgress?: number;
  /** Maximum progress value (default: 90) */
  maxProgress?: number;
}

/**
 * Build-time configuration injected into bootstrap.js.
 */
export interface BuildConfig {
  /** Flutter engine revision hash */
  engineRevision: string;
  /** SW version string */
  swVersion: string;
  /** SW filename */
  swFilename: string;
  /** Build variants from Flutter buildConfig */
  builds: FlutterBuildEntry[];
}

/**
 * A build entry from Flutter's _flutter.buildConfig.builds array.
 */
export interface FlutterBuildEntry {
  compileTarget?: string;
  renderer?: string;
  mainJsPath?: string;
  mainWasmPath?: string;
  jsSupportRuntimePath?: string;
}

/**
 * Progress state exposed via window.Bootstrap.progress.
 */
export interface ProgressState {
  /** Current pipeline phase */
  phase: BootstrapPhase;
  /** Progress percentage (0-100) */
  percent: number;
  /** Human-readable status message */
  message: string;
}

/**
 * Bootstrap pipeline phase names.
 */
export type BootstrapPhase =
  | 'init'
  | 'sw'
  | 'canvaskit'
  | 'assets'
  | 'dart-entry'
  | 'dart-init';

/**
 * Progress message sent from SW to clients.
 */
export interface SWProgressMessage {
  type: 'sw-progress';
  timestamp: number;
  resourcesSize: number;
  resourcesCount: number;
  resourceName: string;
  resourceUrl: string;
  resourceKey: string;
  resourceSize: number;
  loaded: number;
  status: SWProgressStatus;
  error?: string;
}

/**
 * Status values for SW progress messages.
 */
export type SWProgressStatus =
  | 'loading'
  | 'completed'
  | 'updated'
  | 'cached'
  | 'error';
