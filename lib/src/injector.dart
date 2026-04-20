import 'dart:convert';

import 'config.dart';
import 'manifest.dart';

/// Placeholder token in the compiled SW template.
const String _swPlaceholder = '"__INJECT_SW_CONFIG__"';

/// Placeholder token in the compiled bootstrap template.
const String _bootstrapPlaceholder = '"__INJECT_BOOTSTRAP_CONFIG__"';

/// Inject SW configuration into the compiled SW template.
///
/// Replaces the placeholder with the actual config JSON.
String injectSWConfig({
  required String template,
  required String cachePrefix,
  required String version,
  required Map<String, ResourceEntry> manifest,
}) {
  final config = {
    'cachePrefix': cachePrefix,
    'version': version,
    'manifest': {
      for (final entry in manifest.entries) entry.key: entry.value.toJson(),
    },
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
/// `sw.yaml` or CLI flags are baked in.
String injectBootstrapConfig({
  required String template,
  required String engineRevision,
  required String swVersion,
  required String swFilename,
  required List<Map<String, dynamic>> builds,
  required GeneratorConfig config,
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
  if (config.minProgress != 0) uiDefaults['minProgress'] = config.minProgress;
  if (config.maxProgress != 90) uiDefaults['maxProgress'] = config.maxProgress;

  final buildConfig = <String, dynamic>{
    'engineRevision': engineRevision,
    'swVersion': swVersion,
    'swFilename': swFilename,
    'builds': builds,
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
