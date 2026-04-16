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
/// Replaces the placeholder with the build-time config JSON.
String injectBootstrapConfig({
  required String template,
  required String engineRevision,
  required String swVersion,
  required String swFilename,
  required List<Map<String, dynamic>> builds,
  required GeneratorConfig config,
}) {
  final buildConfig = {
    'engineRevision': engineRevision,
    'swVersion': swVersion,
    'swFilename': swFilename,
    'builds': builds,
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
