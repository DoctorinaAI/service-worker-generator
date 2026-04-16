/**
 * Bootstrap entry point.
 *
 * Replaces Flutter's flutter_bootstrap.js with a controlled
 * initialization pipeline featuring progress tracking and a loading widget.
 *
 * Usage in HTML:
 * <script defer id="bootstrap" src="bootstrap.js"
 *   data-config='{"logo":"icons/Icon-192.png","title":"My App"}'></script>
 */

import type { BuildConfig } from '../shared/types';
import { findBootstrapScript, parseDataConfig, resolveConfig } from './config';
import { logVersionBanner } from './console-logger';
import { installGlobalAPI } from './api';
import { runPipeline } from './pipeline';

// Build-time configuration injected by the Dart CLI.
const buildConfig: BuildConfig = "__INJECT_BOOTSTRAP_CONFIG__" as unknown as BuildConfig;

// Initialize when the DOM is ready
function init(): void {
  const script = findBootstrapScript();
  const userConfig = parseDataConfig(script);
  const config = resolveConfig(buildConfig, userConfig);

  // Log version banner
  logVersionBanner(buildConfig);

  // Run the pipeline
  runPipeline(config).then((api) => {
    installGlobalAPI(api);
  });
}

// Start when the page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
