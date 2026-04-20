import 'dart:io' as io;

import 'package:args/args.dart';
import 'package:yaml/yaml.dart' as yaml;

/// Generator configuration with all settings.
class GeneratorConfig {
  /// Create a generator configuration.
  const GeneratorConfig({
    required this.inputDir,
    required this.version,
    this.swOutput = 'sw.js',
    this.bootstrapOutput = 'bootstrap.js',
    this.cachePrefix = 'app-cache',
    this.includeGlobs = const {'**'},
    this.excludeGlobs = const {},
    this.coreGlobs = const {},
    this.requiredGlobs = const {},
    this.optionalGlobs = const {},
    this.ignoreGlobs = const {},
    this.keepMaps = false,
    this.noCleanup = false,
    this.comments = false,
    this.theme = 'auto',
    this.logo = '',
    this.title = '',
    this.color = '#25D366',
    this.minProgress = 0,
    this.maxProgress = 90,
  });

  /// Path to Flutter build output directory.
  final String inputDir;

  /// Output service worker filename.
  final String swOutput;

  /// Output bootstrap filename.
  final String bootstrapOutput;

  /// Cache name prefix.
  final String cachePrefix;

  /// Cache version (defaults to current timestamp).
  final String version;

  /// Glob patterns to include files (semicolon-separated).
  final Set<String> includeGlobs;

  /// Glob patterns to exclude files (semicolon-separated).
  final Set<String> excludeGlobs;

  /// Glob patterns for core category override.
  final Set<String> coreGlobs;

  /// Glob patterns for required category override.
  final Set<String> requiredGlobs;

  /// Glob patterns for optional category override.
  final Set<String> optionalGlobs;

  /// Glob patterns for ignore category override.
  final Set<String> ignoreGlobs;

  /// Keep source map files (.js.map).
  final bool keepMaps;

  /// Skip Flutter file cleanup.
  final bool noCleanup;

  /// Include comments in generated output.
  final bool comments;

  /// Loading widget theme.
  final String theme;

  /// Loading widget logo path.
  final String logo;

  /// Loading widget title.
  final String title;

  /// Loading widget accent color.
  final String color;

  /// Minimum progress value.
  final int minProgress;

  /// Maximum progress value.
  final int maxProgress;

  /// Parse configuration from CLI args, optional YAML file, and env.
  /// Priority: CLI args > YAML > env > defaults.
  // ignore: prefer_constructors_over_static_methods
  static GeneratorConfig parse(List<String> args) {
    final parser = _buildArgParser();
    final results = parser.parse(args);

    if (results['help'] as bool? ?? false) {
      // ignore: avoid_print
      print('Usage: dart run sw:generate [options]\n');
      // ignore: avoid_print
      print(parser.usage);
      // ignore: avoid_print
      print('\nConfig precedence: CLI args > YAML (sw.yaml) > env > defaults');
      // ignore: avoid_print
      print(
        '\nEnvironment variables: SW_INPUT, SW_OUTPUT, SW_BOOTSTRAP_OUTPUT,\n'
        '  SW_PREFIX, SW_VERSION, SW_GLOB, SW_EXCLUDE_GLOB, SW_CORE,\n'
        '  SW_REQUIRED, SW_OPTIONAL, SW_IGNORE, SW_THEME, SW_LOGO,\n'
        '  SW_TITLE, SW_COLOR, SW_MIN_PROGRESS, SW_MAX_PROGRESS',
      );
      io.exit(0);
    }

    // Try loading YAML config
    final yamlConfig = _loadYamlConfig(results['config'] as String?);

    String resolve(String name, String envName, String defaultValue) {
      // `results[name]` returns the ArgParser default when the flag wasn't
      // explicitly passed, which would shadow YAML/env and break the
      // advertised precedence. Use `wasParsed` to tell them apart.
      if (results.wasParsed(name)) return results[name] as String;
      final yamlValue = yamlConfig[name]?.toString();
      if (yamlValue != null) return yamlValue;
      if (envName.isNotEmpty) {
        final envValue = io.Platform.environment[envName];
        if (envValue != null) return envValue;
      }
      return defaultValue;
    }

    Set<String> resolveGlobs(String name, String envName, String defaultValue) {
      final raw = resolve(name, envName, defaultValue);
      return raw.isEmpty
          ? const {}
          : raw
                .split(';')
                .map((e) => e.trim())
                .where((e) => e.isNotEmpty)
                .toSet();
    }

    int parseIntOrFail(String name, String envName, int defaultValue) {
      final raw = resolve(name, envName, defaultValue.toString());
      final parsed = int.tryParse(raw);
      if (parsed == null) {
        io.stderr.writeln(
          'Error: --$name="$raw" is not a valid integer.',
        );
        io.exit(64);
      }
      return parsed;
    }

    return GeneratorConfig(
      inputDir: resolve('input', 'SW_INPUT', 'build/web'),
      swOutput: resolve('output', 'SW_OUTPUT', 'sw.js'),
      bootstrapOutput: resolve(
        'bootstrap-output',
        'SW_BOOTSTRAP_OUTPUT',
        'bootstrap.js',
      ),
      cachePrefix: resolve('prefix', 'SW_PREFIX', 'app-cache'),
      // Empty version is a sentinel: the generator will derive it from
      // the manifest content hash after scanning files. Any CLI/YAML/env
      // override preempts that derivation.
      version: resolve('version', 'SW_VERSION', ''),
      includeGlobs: resolveGlobs('glob', 'SW_GLOB', '**'),
      excludeGlobs: resolveGlobs('no-glob', 'SW_EXCLUDE_GLOB', ''),
      coreGlobs: resolveGlobs('core', 'SW_CORE', ''),
      requiredGlobs: resolveGlobs('required', 'SW_REQUIRED', ''),
      optionalGlobs: resolveGlobs('optional', 'SW_OPTIONAL', ''),
      ignoreGlobs: resolveGlobs('ignore', 'SW_IGNORE', ''),
      keepMaps: results['keep-maps'] as bool? ?? false,
      noCleanup: results['no-cleanup'] as bool? ?? false,
      comments: results['comments'] as bool? ?? false,
      theme: resolve('theme', 'SW_THEME', 'auto'),
      logo: resolve('logo', 'SW_LOGO', ''),
      title: resolve('title', 'SW_TITLE', ''),
      color: resolve('color', 'SW_COLOR', '#25D366'),
      minProgress: parseIntOrFail('min-progress', 'SW_MIN_PROGRESS', 0),
      maxProgress: parseIntOrFail('max-progress', 'SW_MAX_PROGRESS', 90),
    );
  }

  static ArgParser _buildArgParser() => ArgParser()
    ..addFlag('help', abbr: 'h', negatable: false, help: 'Show help')
    ..addOption(
      'input',
      abbr: 'i',
      help: 'Path to Flutter build directory',
      defaultsTo: 'build/web',
    )
    ..addOption(
      'output',
      abbr: 'o',
      help: 'Output SW filename',
      defaultsTo: 'sw.js',
    )
    ..addOption(
      'bootstrap-output',
      help: 'Output bootstrap filename',
      defaultsTo: 'bootstrap.js',
    )
    ..addOption(
      'prefix',
      abbr: 'p',
      help: 'Cache name prefix',
      defaultsTo: 'app-cache',
    )
    ..addOption('version', abbr: 'v', help: 'Cache version')
    ..addOption(
      'glob',
      abbr: 'g',
      help: 'Include glob patterns (semicolon-separated)',
      defaultsTo: '**',
    )
    ..addOption(
      'no-glob',
      abbr: 'e',
      help: 'Exclude glob patterns (semicolon-separated)',
    )
    ..addOption('core', help: 'Core category glob overrides')
    ..addOption('required', help: 'Required category glob overrides')
    ..addOption('optional', help: 'Optional category glob overrides')
    ..addOption('ignore', help: 'Ignore category glob overrides')
    ..addFlag('keep-maps', help: 'Keep .js.map files', defaultsTo: false)
    ..addFlag(
      'no-cleanup',
      help: 'Skip Flutter file cleanup',
      defaultsTo: false,
    )
    ..addFlag(
      'comments',
      abbr: 'c',
      help: 'Include comments in output',
      defaultsTo: false,
    )
    ..addOption('config', help: 'Path to YAML config file')
    ..addOption('theme', help: 'Loading widget theme (light/dark/auto)')
    ..addOption('logo', help: 'Loading widget logo path')
    ..addOption('title', help: 'Loading widget title')
    ..addOption('color', help: 'Loading widget accent color')
    ..addOption('min-progress', help: 'Minimum progress value')
    ..addOption('max-progress', help: 'Maximum progress value');

  static Map<String, dynamic> _loadYamlConfig(String? path) {
    final file = io.File(path ?? 'sw.yaml');
    if (!file.existsSync()) return const {};
    try {
      final content = file.readAsStringSync();
      final doc = yaml.loadYaml(content);
      if (doc is Map) return Map<String, dynamic>.from(doc);
    } on Object catch (e) {
      io.stderr.writeln('Warning: Failed to parse YAML config: $e');
    }
    return const {};
  }
}
