/**
 * Every string the loading screen shows a user, in one place, so a page
 * can replace them.
 *
 * They used to be literals spread across the pipeline and the widget, in
 * English, with no way to change them: an app in another language showed
 * "Loading application" to everyone before its own code ran, and
 * `window.updateLoadingProgress` only exists once Dart has started — which
 * is after all of this (audit #30, item 5.1).
 *
 * The set is closed on purpose. A caller overrides what it needs through
 * the bootstrap's `data-config`:
 *
 * ```html
 * <script defer data-sw-bootstrap src="bootstrap.js"
 *   data-config='{"strings":{"app":"Загрузка приложения","reload":"Обновить"}}'></script>
 * ```
 */
export const DEFAULT_STRINGS = {
  /** Stage 0, before anything has been checked. */
  starting: 'Starting',
  /** Stage 1: reading what the browser can do. */
  environment: 'Checking environment',
  /** Stage 2: registering the service worker. */
  worker: 'Registering service worker',
  /** Stage 2, when a new build's worker has to install first. */
  update: 'Installing update',
  /** Stage 3: CanvasKit or skwasm. */
  engine: 'Loading rendering engine',
  /** Stage 4: the app's own files. */
  app: 'Loading application',
  /**
   * Stage 4's counter. `{done}` and `{total}` are replaced with the number
   * of pre-cached resources that have arrived and the number expected.
   */
  resources: 'Loaded {done} of {total} resources',
  /** Stage 5: the engine is starting. */
  initializing: 'Initializing Flutter engine',
  /** Stage 5: the app is about to run. */
  running: 'Starting application',
  /** Shown when loading failed; the reason goes to the console. */
  failed: 'The application could not be loaded',
  /** Shown instead of [failed] when the browser reports no connection. */
  offline: 'You appear to be offline',
  /** The overlay button, on its first click. */
  reload: 'Reload',
  /** The overlay button, once a plain reload has not helped. */
  reset: 'Clear the cache and reload',
} as const;

/** The name of a string the loading screen shows. */
export type StringKey = keyof typeof DEFAULT_STRINGS;

/** Every string, resolved: the defaults with any override applied. */
export type Strings = Record<StringKey, string>;

/**
 * The defaults with [overrides] applied, ignoring unknown keys and values
 * that are not strings — `data-config` is untyped JSON, and a typo there
 * must not blank out a label.
 */
export function resolveStrings(overrides: unknown): Strings {
  const resolved: Strings = { ...DEFAULT_STRINGS };
  if (!overrides || typeof overrides !== 'object') return resolved;
  for (const [key, value] of Object.entries(overrides)) {
    if (!hasOwn(DEFAULT_STRINGS, key)) continue;
    if (typeof value !== 'string' || value === '') continue;
    resolved[key as StringKey] = value;
  }
  return resolved;
}

/**
 * [template] with each `{name}` replaced by `values[name]`. A placeholder
 * with no value is left as it is, so a broken override is visible rather
 * than silently empty.
 */
export function format(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  // `hasOwn`, not `in`: `in` also finds what every object inherits, so a
  // `{constructor}` in an override rendered a function's source into the
  // loading screen instead of staying the visible placeholder it is.
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    hasOwn(values, name) ? String(values[name]) : match,
  );
}

/**
 * `Object.hasOwn`, which Safari only has from 15.4: there the loading
 * screen's counter threw on every message, and a page with any `strings`
 * override never started at all.
 */
function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
