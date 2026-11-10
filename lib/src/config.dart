import 'dart:io' as io;

import 'package:args/args.dart';
import 'package:glob/glob.dart' as glob;
import 'package:path/path.dart' as p;
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
    this.logLevel = 'info',
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

  /// How much the generated artifacts print on the browser console:
  /// `silent`, `error`, `warn` or `info` (everything, the default).
  final String logLevel;

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
  ///
  /// This is the command line's parser: given `--help`, it prints the usage
  /// and ends the process with status 0, so a build script calling it in
  /// process must not pass that flag through. Construct a
  /// [GeneratorConfig] directly instead where that matters.
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
        '  SW_TITLE, SW_COLOR, SW_MIN_PROGRESS, SW_MAX_PROGRESS,\n'
        '  SW_KEEP_MAPS, SW_NO_CLEANUP, SW_COMMENTS, SW_LOG_LEVEL',
      );
      io.exit(0);
    }

    // Try loading YAML config. Only the implicit sw.yaml may be absent
    // silently; a path the caller named is expected to exist.
    final yamlConfig = _loadYamlConfig(
      results['config'] as String?,
      explicit: results.wasParsed('config'),
      knownKeys: {
        for (final name in parser.options.keys)
          if (name != 'help' && name != 'config') name,
      },
    );

    // Where a value came from, for error messages: the CLI flag, the YAML
    // key (and file) or the environment variable that supplied it.
    _Source cli(String name) => _Source('--$name');
    _Source fromYaml(String name) => _Source(name, ' (in ${yamlConfig.path})');
    _Source env(String envName) => _Source(envName, ' (environment)');

    // The raw value and its source. A YAML list is only accepted where
    // [listSeparator] says how to join it into the CLI/env form.
    (String, _Source)? lookup(
      String name,
      String envName, {
      String? listSeparator,
    }) {
      // `results[name]` returns the ArgParser default when the flag wasn't
      // explicitly passed, which would shadow YAML/env and break the
      // advertised precedence. Use `wasParsed` to tell them apart.
      if (results.wasParsed(name)) {
        return (results[name] as String, cli(name));
      }
      final node = yamlConfig.nodes[name];
      if (node != null) {
        final value = _yamlText(
          node,
          name,
          yamlConfig.path,
          listSeparator: listSeparator,
        );
        if (value != null) return (value, fromYaml(name));
      }
      if (envName.isNotEmpty) {
        final envValue = io.Platform.environment[envName];
        if (envValue != null) return (envValue, env(envName));
      }
      return null;
    }

    String resolve(String name, String envName, String defaultValue) =>
        lookup(name, envName)?.$1 ?? defaultValue;

    Set<String> resolveGlobs(String name, String envName, String defaultValue) {
      final (raw, source) =
          lookup(name, envName, listSeparator: ';') ??
          (defaultValue, cli(name));
      final globs = raw.isEmpty
          ? const <String>{}
          : raw
                .split(';')
                .map((e) => e.trim())
                .where((e) => e.isNotEmpty)
                .toSet();
      // Compile them now: a malformed pattern would otherwise surface
      // halfway through generate() as a crash with a stack trace.
      for (final pattern in globs) {
        try {
          glob.Glob(pattern, context: p.url, recursive: true);
        } on FormatException catch (e) {
          throw FormatException(
            '${source.option}${source.where} contains "$pattern", which is '
            'not a valid glob pattern: ${e.message}',
          );
        }
        _warnSegmentOnlyGlob(pattern, source);
      }
      return globs;
    }

    int parseIntOrFail(String name, String envName, int defaultValue) {
      final found = lookup(name, envName);
      if (found == null) return defaultValue;
      final (raw, source) = found;
      final parsed = int.tryParse(raw.trim());
      if (parsed == null) {
        throw FormatException(
          '${source.option}="$raw"${source.where} is not a valid integer.',
        );
      }
      return parsed;
    }

    // Flags get the same precedence as options. `results[name]` alone would
    // return the flag's default whenever it was not passed, so a
    // `no-cleanup: true` in sw.yaml was silently ignored.
    bool resolveFlag(String name, String envName) {
      if (results.wasParsed(name)) return results[name] as bool;
      final found = lookup(name, envName);
      if (found == null) return false;
      final (raw, source) = found;
      switch (raw.trim().toLowerCase()) {
        case 'true' || '1' || 'yes':
          return true;
        case 'false' || '0' || 'no' || '':
          return false;
      }
      throw FormatException(
        '${source.option}="$raw"${source.where} is not a valid boolean.',
      );
    }

    String resolveChecked(
      String name,
      String envName,
      String defaultValue,
      void Function(String value, String option, [String where]) check,
    ) {
      final found = lookup(name, envName);
      if (found == null) return defaultValue;
      final (value, source) = found;
      check(value, source.option, source.where);
      return value;
    }

    final minProgress = parseIntOrFail('min-progress', 'SW_MIN_PROGRESS', 0);
    final maxProgress = parseIntOrFail('max-progress', 'SW_MAX_PROGRESS', 90);
    _checkProgressRange(minProgress, maxProgress);

    final swOutput = resolveChecked(
      'output',
      'SW_OUTPUT',
      'sw.js',
      _checkOutputName,
    );
    final bootstrapOutput = resolveChecked(
      'bootstrap-output',
      'SW_BOOTSTRAP_OUTPUT',
      'bootstrap.js',
      _checkOutputName,
    );
    _checkDistinctOutputs(swOutput, bootstrapOutput);

    return GeneratorConfig(
      inputDir: resolve('input', 'SW_INPUT', 'build/web'),
      swOutput: swOutput,
      bootstrapOutput: bootstrapOutput,
      cachePrefix: resolveChecked(
        'prefix',
        'SW_PREFIX',
        'app-cache',
        _checkPrefix,
      ),
      // Empty version is a sentinel: the generator will derive it from
      // the manifest content hash after scanning files. Any CLI/YAML/env
      // override preempts that derivation.
      version: resolveChecked('version', 'SW_VERSION', '', _checkVersion),
      includeGlobs: resolveGlobs('glob', 'SW_GLOB', '**'),
      excludeGlobs: resolveGlobs('no-glob', 'SW_EXCLUDE_GLOB', ''),
      coreGlobs: resolveGlobs('core', 'SW_CORE', ''),
      requiredGlobs: resolveGlobs('required', 'SW_REQUIRED', ''),
      optionalGlobs: resolveGlobs('optional', 'SW_OPTIONAL', ''),
      ignoreGlobs: resolveGlobs('ignore', 'SW_IGNORE', ''),
      keepMaps: resolveFlag('keep-maps', 'SW_KEEP_MAPS'),
      noCleanup: resolveFlag('no-cleanup', 'SW_NO_CLEANUP'),
      comments: _warnDeprecatedComments(resolveFlag('comments', 'SW_COMMENTS')),
      theme: _normalizeTheme(resolve('theme', 'SW_THEME', 'auto')),
      // Normalized here so the artifacts carry one spelling of it.
      logLevel: resolveChecked(
        'log-level',
        'SW_LOG_LEVEL',
        'info',
        _checkLogLevel,
      ).trim().toLowerCase(),
      logo: resolve('logo', 'SW_LOGO', ''),
      title: resolve('title', 'SW_TITLE', ''),
      color: _checkColor(resolve('color', 'SW_COLOR', '#25D366')),
      minProgress: minProgress,
      maxProgress: maxProgress,
    );
  }

  /// Check the values that would make the generator write outside the
  /// build directory or produce a worker that cannot work: the output file
  /// names and the cache version.
  ///
  /// [parse] already runs these checks, naming the CLI flag, YAML key or
  /// environment variable a bad value came from. `generate` calls this
  /// again for configurations built directly in code.
  ///
  /// Throws a [FormatException] describing the first problem found.
  void validate() {
    _checkOutputName(swOutput, '--output');
    _checkOutputName(bootstrapOutput, '--bootstrap-output');
    _checkDistinctOutputs(swOutput, bootstrapOutput);
    _checkPrefix(cachePrefix, '--prefix');
    if (version.isNotEmpty) _checkVersion(version, '--version');
    _checkLogLevel(logLevel, '--log-level');
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
    // No `allowed:`: the YAML key and the environment variable never pass
    // through ArgParser, and `_checkLogLevel` accepts any case, so one
    // check for all three channels gives one error message for all three.
    ..addOption(
      'log-level',
      help:
          'Console output of the generated artifacts '
          '(silent/error/warn/info)',
      defaultsTo: 'info',
    )
    ..addOption('logo', help: 'Loading widget logo path')
    ..addOption('title', help: 'Loading widget title')
    ..addOption('color', help: 'Loading widget accent color')
    ..addOption('min-progress', help: 'Minimum progress value')
    ..addOption('max-progress', help: 'Maximum progress value');

  static ({String path, Map<String, yaml.YamlNode> nodes}) _loadYamlConfig(
    String? path, {
    required bool explicit,
    required Set<String> knownKeys,
  }) {
    final file = io.File(path ?? 'sw.yaml');
    final none = (path: file.path, nodes: const <String, yaml.YamlNode>{});
    if (!file.existsSync()) {
      // A file the caller named is a requirement, not a preference: a
      // typo in `--config=sw-prod.yaml` used to warn and then deploy with
      // every default — the prefix, the categories and the branding of an
      // app nobody configured. The implicit `sw.yaml` stays optional.
      if (explicit) {
        throw FormatException('--config="${file.path}" does not exist.');
      }
      return none;
    }
    final yaml.YamlNode doc;
    try {
      final content = file.readAsStringSync();
      // Nodes, not values: a value such as `version: 1.10` must keep the
      // text the user wrote rather than become the double 1.1.
      doc = yaml.loadYamlNode(content, sourceUrl: file.uri);
    } on Object catch (e) {
      // Unparseable YAML in a file that was asked for by name is a
      // configuration error, not something to continue past with defaults.
      // (`YamlException` is itself a `FormatException`, so this cannot be
      // told apart by type from the ones raised deliberately below — which
      // is why they are raised outside this `try`.)
      if (explicit) {
        throw FormatException('Failed to parse ${file.path}: $e');
      }
      io.stderr.writeln('Warning: Failed to parse YAML config: $e');
      return none;
    }
    // An empty file is a valid "no settings".
    if (doc is yaml.YamlScalar && doc.value == null) return none;
    if (doc is! yaml.YamlMap) {
      if (explicit) {
        throw FormatException(
          'Config file ${file.path} is not a mapping of option names to '
          'values (found ${doc.value.runtimeType}).',
        );
      }
      io.stderr.writeln(
        'Warning: config file ${file.path} is not a mapping of option '
        'names to values (found ${doc.value.runtimeType}); it is ignored.',
      );
      return none;
    }
    final nodes = <String, yaml.YamlNode>{};
    for (final MapEntry(:key, :value) in doc.nodes.entries) {
      final name = key is yaml.YamlNode ? key.value : key;
      nodes['$name'] = value;
    }
    io.stdout.writeln('Using config file: ${file.path}');
    for (final MapEntry(:key, :value) in nodes.entries) {
      if (!knownKeys.contains(key)) {
        final suggestion = _suggestOption(key, knownKeys);
        io.stderr.writeln(
          'Warning: unknown key "$key" in ${file.path} is ignored'
          '${suggestion == null ? '' : '; did you mean "$suggestion"?'}',
        );
      } else if (value is yaml.YamlScalar && value.value == null) {
        // `color: #fff` is the usual cause: the # starts a comment.
        final hint = key == 'color'
            ? 'An unquoted # starts a YAML comment; quote the value: '
                  'color: "#25D366".'
            : 'Give it a value or remove the key.';
        io.stderr.writeln(
          'Warning: key "$key" has no value in ${file.path} and is ignored. '
          '$hint',
        );
      }
    }
    return (path: file.path, nodes: nodes);
  }
}

/// Where a configuration value came from, for error messages.
final class _Source {
  const _Source(this.option, [this.where = '']);

  /// The CLI flag (`--core`), YAML key (`core`) or environment variable
  /// (`SW_CORE`) that supplied the value.
  final String option;

  /// Where [option] was found, such as ` (in sw.yaml)`; empty for the CLI.
  final String where;
}

/// The text of YAML [node] for option [name], or `null` when it has no
/// value.
///
/// A plain scalar keeps its source text, so `version: 1.10` stays `1.10`
/// and `title: 0x1F` stays `0x1F` instead of passing through a number. A
/// quoted or block scalar is already the string the user meant.
///
/// A list is joined with [listSeparator], the separator the option's CLI
/// and environment forms use; options without one reject lists. Mappings
/// are always rejected, with a [FormatException] naming [name] and [path].
String? _yamlText(
  yaml.YamlNode node,
  String name,
  String path, {
  String? listSeparator,
}) {
  String scalar(yaml.YamlScalar node) =>
      node.style == yaml.ScalarStyle.PLAIN ? node.span.text : '${node.value}';

  switch (node) {
    case yaml.YamlScalar(value: null):
      return null;
    case yaml.YamlScalar():
      return scalar(node);
    case yaml.YamlList() when listSeparator != null:
      final items = <String>[];
      for (final item in node.nodes) {
        final found = switch (item) {
          yaml.YamlScalar(value: null) => 'an empty item',
          yaml.YamlScalar() => null,
          yaml.YamlMap() => 'a nested mapping',
          _ => 'a nested list',
        };
        if (found != null) {
          throw FormatException(
            'Every item of "$name" in $path must be a single value; found '
            '$found at line ${item.span.start.line + 1}.',
          );
        }
        items.add(scalar(item as yaml.YamlScalar));
      }
      return items.join(listSeparator);
    case yaml.YamlList():
      throw FormatException(
        '"$name" in $path is a list, but it takes a single value.',
      );
    default:
      final accepted = listSeparator == null
          ? 'a single value'
          : 'a string or a list of strings';
      throw FormatException(
        '"$name" in $path is a mapping, but it takes $accepted.',
      );
  }
}

/// Reject an output file name that is not a plain file name in the build
/// directory. [option] and [where] name the source of the value.
///
/// A worker's default scope is the directory its script is served from, so
/// `js/sw.js` registers a worker for `/js/` that never controls the page,
/// and `../sw.js` or an absolute path writes outside the build entirely.
void _checkOutputName(String name, String option, [String where = '']) {
  final String problem;
  if (name.trim().isEmpty) {
    problem = 'is empty';
  } else if (name.contains('/') || name.contains(r'\')) {
    problem =
        'contains a path separator. The outputs must sit next to '
        'index.html: a service worker only controls pages under the '
        'directory it is served from, so a worker in a subdirectory never '
        'controls the app';
  } else if (name == '.' || name == '..' || name.contains('..')) {
    problem = 'contains "..", which would leave the build directory';
  } else if (p.isAbsolute(name) ||
      p.windows.isAbsolute(name) ||
      name.contains(':')) {
    problem = 'is an absolute path, which would leave the build directory';
  } else if (_reservedOutputNames.contains(name.toLowerCase())) {
    problem =
        'is a name this generator removes from the build. Cleanup deletes '
        'Flutter\'s own loader files after generation, so the file written '
        'here would be deleted again and the deploy would 404 for it';
  } else if (name.toLowerCase() == 'index.html') {
    problem =
        'is the app shell, which the generator rewrites rather than '
        'replaces';
  } else {
    return;
  }
  throw FormatException(
    '$option="$name"$where $problem. Give a plain file name such as '
    '"sw.js".',
  );
}

/// Names the generator's own cleanup deletes from the build directory, so
/// an output written under one of them would not survive the run. The list
/// mirrors `_flutterFilesToRemove` in `cleanup.dart`; `main.dart.js` is
/// here for a different reason — it is a Core manifest entry, hashed
/// before the outputs are written, so overwriting it makes every load fail
/// the integrity check.
const Set<String> _reservedOutputNames = {
  'flutter_bootstrap.js',
  'flutter_service_worker.js',
  'flutter.js',
  '.last_build_id',
  'main.dart.js',
  'main.dart.wasm',
  'main.dart.mjs',
};

/// Reject a service worker and a bootstrap written to the same file.
void _checkDistinctOutputs(String swOutput, String bootstrapOutput) {
  if (swOutput.toLowerCase() != bootstrapOutput.toLowerCase()) return;
  throw FormatException(
    'The service worker and the bootstrap would both be written to '
    '"$swOutput"; give --output and --bootstrap-output different names.',
  );
}

/// Reject a cache prefix that cannot name a cache of this app's own.
///
/// Every cache the worker keeps is named `{prefix}-...`, and the prefix is
/// also what scopes the loading screen's "clear the cache and reload": an
/// empty one makes that button delete every cache on the origin, including
/// another app's deployed beside this one. A prefix that is only
/// whitespace, or one carrying a path separator, names caches no cleanup
/// of ours matches.
void _checkPrefix(String prefix, String option, [String where = '']) {
  final String problem;
  if (prefix.trim().isEmpty) {
    problem =
        'is empty. The prefix names this app\'s caches and scopes the '
        'loading screen\'s cache reset, which would otherwise clear every '
        'cache on the origin';
  } else if (prefix != prefix.trim()) {
    problem = 'starts or ends with whitespace';
  } else if (prefix.contains('/') || prefix.contains(r'\')) {
    problem = 'contains a path separator';
  } else {
    return;
  }
  throw FormatException(
    '$option="$prefix"$where $problem. Give a plain name such as '
    '"app-cache".',
  );
}

/// Reject a cache version that collides with the worker's own cache names.
///
/// The worker keeps `{prefix}-{version}`, `{prefix}-temp-{version}` and
/// `{prefix}-manifest`: version `manifest` makes the content cache the
/// manifest cache, a version starting with `temp-` names the temporary
/// cache of another version, which activation deletes, and a version ending
/// in `-manifest` gives the content cache a name the worker reads as the
/// manifest cache of another app (prefix `{prefix}-…`), so it is never
/// cleaned up.
void _checkVersion(String version, String option, [String where = '']) {
  final String problem;
  if (version == 'manifest') {
    problem =
        'would name the content cache "{prefix}-manifest", the cache the '
        'service worker keeps its manifest in';
  } else if (version.startsWith('temp-')) {
    problem =
        'starts with "temp-", so its content cache "{prefix}-$version" '
        'looks like the temporary install cache of version '
        '"${version.substring(5)}" and can be deleted as one';
  } else if (version.endsWith('-manifest')) {
    problem =
        'ends with "-manifest", so its content cache "{prefix}-$version" '
        'looks like the manifest cache of another app on the origin, and '
        'the service worker would never delete it as outdated';
  } else {
    return;
  }
  throw FormatException(
    '$option="$version"$where $problem. Choose another version.',
  );
}

/// Console verbosity levels the generated artifacts understand, from
/// quietest to loudest.
const List<String> _logLevels = ['silent', 'error', 'warn', 'info'];

/// Reject a console verbosity level the artifacts would not understand.
///
/// `ArgParser` rejects a bad `--log-level` itself; this covers the YAML
/// key and the environment variable, which it never sees. [option] and
/// [where] name where the value came from.
void _checkLogLevel(String level, String option, [String where = '']) {
  if (_logLevels.contains(level.trim().toLowerCase())) return;
  throw FormatException(
    '$option="$level"$where is not a log level. Use one of '
    '${_logLevels.join(", ")}.',
  );
}

/// Warn when `--comments` is switched on: it has never had an effect.
///
/// The flag was reserved for emitting commented output, which the
/// artifacts cannot have — they are built and minified by Vite before the
/// generator ever sees them. Accepting it silently left a configuration
/// that reads as if it does something. The value is returned unchanged.
bool _warnDeprecatedComments(bool enabled) {
  if (!enabled) return enabled;
  io.stderr.writeln(
    'Warning: --comments has no effect on the output (sw.js and '
    'bootstrap.js ship minified) and will be removed. Drop it.',
  );
  return enabled;
}

/// Warn about a pattern that only matches the top level of the build.
///
/// `*` does not cross a `/` in `package:glob`, so `*.png` matches
/// `favicon.png` and nothing under `assets/` — while the user who wrote it
/// almost certainly meant every PNG. The pattern is left alone (changing
/// what it matches would change what existing configurations categorise);
/// it is the silence that was the problem.
void _warnSegmentOnlyGlob(String pattern, _Source source) {
  // Only the plain `*.ext` shape, which is the one that reads like
  // `.gitignore`. Anything with a `/` or a `**` was written by someone who
  // knows what the separator does, and a bare `*` says "the files here".
  if (!RegExp(r'^\*[^*/]+$').hasMatch(pattern)) return;
  io.stderr.writeln(
    'Warning: ${source.option}="$pattern"${source.where} matches only the '
    'top level of the build directory: "*" does not cross "/". Write '
    '"**/$pattern" to match it in every directory, or '
    '"{$pattern,**/$pattern}" for both.',
  );
}

/// Loading widget themes the bootstrap understands.
const Set<String> _themes = {'light', 'dark', 'auto'};

/// Match [raw] against [_themes] ignoring case and surrounding whitespace.
/// An unknown theme is passed through, as before, with a warning: the
/// widget falls back to its light theme for it.
String _normalizeTheme(String raw) {
  final theme = raw.trim().toLowerCase();
  if (_themes.contains(theme)) return theme;
  if (theme.isEmpty) return raw;
  io.stderr.writeln(
    'Warning: theme "$raw" is not one of ${_themes.join(", ")}; '
    'the loading widget will fall back to its default look.',
  );
  return raw;
}

/// Hex colours the loading widget's styles are written for.
final RegExp _hexColor = RegExp(
  r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
);

/// Warn when [raw] is not a hex colour; it is passed through unchanged
/// apart from surrounding whitespace.
String _checkColor(String raw) {
  final color = raw.trim();
  if (color.isNotEmpty && !_hexColor.hasMatch(color)) {
    io.stderr.writeln(
      'Warning: color "$raw" is not a #rgb, #rrggbb or #rrggbbaa hex '
      'colour; the loading widget\'s glow and pulse styles may not render.',
    );
  }
  return color;
}

/// Warn when the progress bounds are outside 0..100 or inverted. They are
/// passed through unchanged; the loading widget corrects them at runtime.
void _checkProgressRange(int min, int max) {
  for (final (name, value) in [('min-progress', min), ('max-progress', max)]) {
    if (value < 0 || value > 100) {
      io.stderr.writeln(
        'Warning: $name ($value) is outside 0..100; '
        'the loading widget will correct it at runtime.',
      );
    }
  }
  if (min > max) {
    io.stderr.writeln(
      'Warning: min-progress ($min) is greater than max-progress ($max); '
      'the loading widget will correct the range at runtime.',
    );
  }
}

/// The option [key] most likely meant, or `null` when none is close.
String? _suggestOption(String key, Set<String> options) {
  // camelCase and snake_case spellings of a kebab-case option.
  final normalized = key
      .trim()
      .replaceAllMapped(RegExp('([a-z0-9])([A-Z])'), (m) => '${m[1]}-${m[2]}')
      .replaceAll('_', '-')
      .toLowerCase();
  if (options.contains(normalized)) return normalized;

  String? best;
  var bestDistance = 3;
  for (final option in options) {
    final distance = _editDistance(normalized, option);
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  if (best != null) return best;

  // A qualified spelling such as `cache-prefix` or `sw-output`.
  for (final option
      in options.toList()..sort((a, b) => b.length.compareTo(a.length))) {
    if (normalized.endsWith('-$option') || normalized.startsWith('$option-')) {
      return option;
    }
  }
  return null;
}

/// Levenshtein distance between [a] and [b].
int _editDistance(String a, String b) {
  var previous = List<int>.generate(b.length + 1, (i) => i);
  for (var i = 1; i <= a.length; i++) {
    final current = List<int>.filled(b.length + 1, 0)..[0] = i;
    for (var j = 1; j <= b.length; j++) {
      final cost = a[i - 1] == b[j - 1] ? 0 : 1;
      current[j] = [
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      ].reduce((x, y) => x < y ? x : y);
    }
    previous = current;
  }
  return previous[b.length];
}
