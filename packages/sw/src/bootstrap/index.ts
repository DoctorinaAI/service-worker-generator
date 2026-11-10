/**
 * Bootstrap entry point.
 *
 * Replaces Flutter's flutter_bootstrap.js with a controlled
 * initialization pipeline featuring progress tracking and a loading widget.
 *
 * Usage in HTML:
 * <script defer data-sw-bootstrap src="bootstrap.js"
 *   data-config='{"logo":"icons/Icon-192.png","title":"My App"}'></script>
 */

import type { BuildConfig } from '../shared/types';
import { findBootstrapScript, parseDataConfig, resolveConfig } from './config';
import { log, setLogLevel } from '../shared/logger';
import { logVersionBanner } from './console-logger';
import { installGlobalAPI } from './api';
import { runPipeline } from './pipeline';

// Build-time configuration injected by the Dart CLI. See sw/index.ts for
// why there is no runtime validation here.
const buildConfig: BuildConfig =
  "__INJECT_BOOTSTRAP_CONFIG__" as unknown as BuildConfig;

// Before the first line anything here prints. A page may override it in
// `data-config`, which `resolveConfig` applies as soon as it is parsed.
setLogLevel(buildConfig.logLevel);

/**
 * Set once a bootstrap has started on this page. A shell that includes
 * `bootstrap.js` twice — a template edited by hand, a kept
 * `flutter_bootstrap.js` beside it — otherwise ran two pipelines, two
 * loading screens and two `_flutter.loader.load()` calls, and the second
 * `window.Bootstrap` replaced the first.
 */
const STARTED = '__swBootstrapStarted';

// Initialize when the DOM is ready
function init(): void {
  const flags = window as unknown as Record<string, unknown>;
  if (flags[STARTED]) {
    log.warn('[Bootstrap] bootstrap.js was loaded twice; ignoring the second copy');
    return;
  }
  flags[STARTED] = true;
  const script = findBootstrapScript();
  const userConfig = parseDataConfig(script);
  const config = resolveConfig(buildConfig, userConfig);

  logVersionBanner(buildConfig);

  // Install the global API synchronously, before any await yields control
  // to Flutter — Dart's main() may call window.updateLoadingProgress during
  // the same microtask chain, so those globals must already exist.
  const api = runPipeline(config);
  installGlobalAPI(api);
}

// Start when the page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
