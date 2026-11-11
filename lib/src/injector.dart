import 'dart:convert';

import 'config.dart';
import 'manifest.dart';

/// Placeholder token in the compiled SW template.
const String _swPlaceholder = '"__INJECT_SW_CONFIG__"';

/// Placeholder token in the compiled bootstrap template.
const String _bootstrapPlaceholder = '"__INJECT_BOOTSTRAP_CONFIG__"';

/// Inject SW configuration into the compiled SW template.
///
/// Replaces the placeholder with the actual config JSON. [logLevel] is how
/// much the worker prints on the console; the default, `info`, is left out
/// of the config, which is what the worker assumes.
String injectSWConfig({
  required String template,
  required String cachePrefix,
  required String version,
  required Map<String, ResourceEntry> manifest,
  String engineRevision = '',
  String logLevel = 'info',
}) {
  final config = {
    'cachePrefix': cachePrefix,
    'version': version,
    // Omitted for the default, like the fields below: the worker logs
    // everything unless it is told otherwise.
    if (logLevel.isNotEmpty && logLevel != 'info') 'logLevel': logLevel,
    'manifest': {
      for (final entry in manifest.entries) entry.key: entry.value.toJson(),
    },
    // Answers `getVersion`, so a later bootstrap can tell whether the code
    // this worker serves runs on its engine. Omitted when unknown.
    if (engineRevision.isNotEmpty) 'engineRevision': engineRevision,
  };

  final json = jsonEncode(config);

  if (!template.contains(_swPlaceholder)) {
    throw StateError(
      'SW template does not contain placeholder $_swPlaceholder',
    );
  }

  return template.replaceFirst(_swPlaceholder, json);
}

/// Inject bootstrap configuration into the compiled bootstrap template.
///
/// Replaces the placeholder with the build-time config JSON, including
/// loading-widget defaults so brand colours/titles/logos supplied via
/// `sw.yaml` or CLI flags are baked in. [useLocalCanvasKit] carries
/// Flutter's `--no-web-resources-cdn` choice through to the bootstrap,
/// which then loads the engine locally without probing the CDN.
String injectBootstrapConfig({
  required String template,
  required String engineRevision,
  required String swVersion,
  required String swFilename,
  required List<Map<String, dynamic>> builds,
  required GeneratorConfig config,
  bool useLocalCanvasKit = false,
}) {
  // Only ship fields that actually differ from bootstrap's hardcoded
  // defaults — otherwise every generated bootstrap.js would embed the
  // same redundant uiDefaults block, bloating the artifact.
  final uiDefaults = <String, dynamic>{};
  if (config.logo.isNotEmpty) uiDefaults['logo'] = config.logo;
  if (config.title.isNotEmpty) uiDefaults['title'] = config.title;
  if (config.theme.isNotEmpty && config.theme != 'auto') {
    uiDefaults['theme'] = config.theme;
  }
  if (config.color.isNotEmpty && config.color != '#25D366') {
    uiDefaults['color'] = config.color;
  }
  // Only ever written when it is false: `true` is the bootstrap's own
  // default, and an artifact should not carry a setting that changes
  // nothing.
  if (config.noWidget) uiDefaults['showWidget'] = false;
  if (config.minProgress != 0) uiDefaults['minProgress'] = config.minProgress;
  if (config.maxProgress != 90) uiDefaults['maxProgress'] = config.maxProgress;

  final buildConfig = <String, dynamic>{
    if (config.logLevel.isNotEmpty && config.logLevel != 'info')
      'logLevel': config.logLevel,
    'engineRevision': engineRevision,
    'swVersion': swVersion,
    'swFilename': swFilename,
    'builds': builds,
    // Scopes the loading widget's "clear cache and reload" to this app's
    // caches instead of every cache on the origin.
    if (config.cachePrefix.isNotEmpty) 'cachePrefix': config.cachePrefix,
    // Omitted when false, like uiDefaults: the bootstrap defaults to CDN.
    if (useLocalCanvasKit) 'useLocalCanvasKit': true,
    if (uiDefaults.isNotEmpty) 'uiDefaults': uiDefaults,
  };

  final json = jsonEncode(buildConfig);

  if (!template.contains(_bootstrapPlaceholder)) {
    throw StateError(
      'Bootstrap template does not contain placeholder '
      '$_bootstrapPlaceholder',
    );
  }

  return template.replaceFirst(_bootstrapPlaceholder, json);
}
