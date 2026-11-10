import 'dart:io' as io;

import 'package:path/path.dart' as p;
import 'package:sw/src/config.dart';
import 'package:test/test.dart';

import 'support/capture.dart';

/// Tests for [GeneratorConfig.parse] — focuses on the precedence rules
/// (CLI > YAML > env > default) since those regressed once when the env
/// names for glob options silently became empty strings.
void main() {
  group('GeneratorConfig.parse', () {
    test('applies defaults when no flags are provided', () {
      final config = GeneratorConfig.parse(const ['--input=.']);
      expect(config.inputDir, '.');
      expect(config.swOutput, 'sw.js');
      expect(config.bootstrapOutput, 'bootstrap.js');
      expect(config.cachePrefix, 'app-cache');
      expect(config.theme, 'auto');
      expect(config.color, '#25D366');
      expect(config.minProgress, 0);
      expect(config.maxProgress, 90);
      expect(config.includeGlobs, equals({'**'}));
    });

    test('CLI arg overrides default', () {
      final config = GeneratorConfig.parse(const [
        '--input=custom/build',
        '--prefix=my-cache',
        '--color=#abcdef',
        '--min-progress=10',
        '--max-progress=80',
      ]);
      expect(config.inputDir, 'custom/build');
      expect(config.cachePrefix, 'my-cache');
      expect(config.color, '#abcdef');
      expect(config.minProgress, 10);
      expect(config.maxProgress, 80);
    });

    test('splits semicolon-separated globs and drops blanks', () {
      final config = GeneratorConfig.parse(const [
        '--core=main.dart.js; *.support.wasm;',
      ]);
      expect(config.coreGlobs, equals({'main.dart.js', '*.support.wasm'}));
    });

    test('YAML fills in when CLI omits a flag', () async {
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      try {
        final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
          ..writeAsStringSync('''
prefix: yaml-cache
title: YAML Title
color: "#112233"
''');
        final config = GeneratorConfig.parse([
          '--config=${yaml.path}',
          '--input=build/web',
        ]);
        expect(config.cachePrefix, 'yaml-cache');
        expect(config.title, 'YAML Title');
        expect(config.color, '#112233');
      } finally {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('CLI arg wins over YAML', () async {
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      try {
        final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
          ..writeAsStringSync('prefix: yaml-cache\n');
        final config = GeneratorConfig.parse([
          '--config=${yaml.path}',
          '--prefix=cli-cache',
        ]);
        expect(config.cachePrefix, 'cli-cache');
      } finally {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('corrupt YAML in a named config fails the run', () async {
      // A file the caller named by hand is a requirement: deploying with
      // every default because of a syntax error is worse than stopping.
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      try {
        final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
          ..writeAsStringSync(': : not valid yaml : :\n');
        expect(
          () => GeneratorConfig.parse(['--config=${yaml.path}']),
          throwsA(isA<FormatException>()),
        );
      } finally {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('corrupt YAML in the default sw.yaml only warns', () async {
      // Nobody asked for this file by name; it is a convenience, and the
      // run continues on CLI args, env and defaults as it always did.
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      final cwd = io.Directory.current;
      try {
        io.File(p.join(tempDir.path, 'sw.yaml'))
          ..createSync()
          ..writeAsStringSync(': : not valid yaml : :\n');
        io.Directory.current = tempDir;
        final config = GeneratorConfig.parse(const <String>[]);
        expect(config.cachePrefix, 'app-cache');
      } finally {
        io.Directory.current = cwd;
        tempDir.deleteSync(recursive: true);
      }
    });

    test('YAML sets boolean flags the CLI omits', () async {
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      try {
        final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
          ..writeAsStringSync('''
keep-maps: true
no-cleanup: true
comments: "yes"
''');
        final config = GeneratorConfig.parse(['--config=${yaml.path}']);
        expect(config.keepMaps, isTrue);
        expect(config.noCleanup, isTrue);
        expect(config.comments, isTrue);
      } finally {
        await tempDir.delete(recursive: true);
      }
    });

    test('a CLI flag wins over YAML, in both directions', () async {
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      try {
        final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
          ..writeAsStringSync('keep-maps: true\nno-cleanup: false\n');
        final config = GeneratorConfig.parse([
          '--config=${yaml.path}',
          '--no-keep-maps',
          '--no-cleanup',
        ]);
        expect(config.keepMaps, isFalse);
        expect(config.noCleanup, isTrue);
      } finally {
        await tempDir.delete(recursive: true);
      }
    });

    test('YAML flags accept numeric and yes/no spellings', () async {
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      try {
        final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
          ..writeAsStringSync('''
keep-maps: 1
no-cleanup: "No"
comments: ""
''');
        final config = GeneratorConfig.parse(['--config=${yaml.path}']);
        expect(config.keepMaps, isTrue);
        expect(config.noCleanup, isFalse);
        expect(config.comments, isFalse);
      } finally {
        await tempDir.delete(recursive: true);
      }
    });

    test('a negated CLI flag still wins over YAML true', () async {
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      try {
        final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
          ..writeAsStringSync('no-cleanup: true\ncomments: true\n');
        final config = GeneratorConfig.parse([
          '--config=${yaml.path}',
          '--no-no-cleanup',
          '--no-comments',
        ]);
        expect(config.noCleanup, isFalse);
        expect(config.comments, isFalse);
      } finally {
        await tempDir.delete(recursive: true);
      }
    });

    test('-c is the short form of --comments', () {
      final config = GeneratorConfig.parse(const ['-c']);
      expect(config.comments, isTrue);
    });

    test('YAML fills in globs and progress bounds', () async {
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      try {
        final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
          ..writeAsStringSync('''
no-glob: "**/*.map; assets/NOTICES"
ignore: "assets/video/**"
min-progress: 5
max-progress: 75
''');
        final config = GeneratorConfig.parse(['--config=${yaml.path}']);
        expect(config.excludeGlobs, {'**/*.map', 'assets/NOTICES'});
        expect(config.ignoreGlobs, {'assets/video/**'});
        expect(config.minProgress, 5);
        expect(config.maxProgress, 75);
      } finally {
        await tempDir.delete(recursive: true);
      }
    });

    test('boolean flags default to false', () {
      final config = GeneratorConfig.parse(const []);
      expect(config.keepMaps, isFalse);
      expect(config.noCleanup, isFalse);
      expect(config.comments, isFalse);
    });

    test('CLI-supplied version is preserved verbatim', () {
      final config = GeneratorConfig.parse(const ['--version=2026.04.20']);
      expect(config.version, '2026.04.20');
    });

    test('default version is empty (generator derives from manifest hash)', () {
      final config = GeneratorConfig.parse(const []);
      expect(config.version, isEmpty);
    });
  });
  group('GeneratorConfig.parse diagnostics', () {
    late io.Directory tempDir;

    setUp(() {
      tempDir = io.Directory.systemTemp.createTempSync('sw-config-diag-');
    });

    tearDown(() => tempDir.deleteSync(recursive: true));

    Future<CapturedOutput<GeneratorConfig>> parseWith(
      String yamlContent, [
      List<String> args = const [],
    ]) {
      final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
        ..writeAsStringSync(yamlContent);
      return captureOutput(
        () => GeneratorConfig.parse(['--config=${yaml.path}', ...args]),
      );
    }

    test('warns about unknown YAML keys and suggests the option', () async {
      final out = await parseWith('''
cache-prefix: foo
no_cleanup: true
titel: Shop
zzz: 1
prefix: ok
''');
      expect(out.stderr, contains('Warning: unknown key "cache-prefix" in '));
      expect(out.stderr, contains('did you mean "prefix"?'));
      expect(out.stderr, contains('"no_cleanup"'));
      expect(out.stderr, contains('did you mean "no-cleanup"?'));
      expect(out.stderr, contains('did you mean "title"?'));
      expect(out.stderr, contains('unknown key "zzz"'));
      expect(out.stderr, isNot(contains('"prefix" in')));
      // Still ignored, as before.
      expect(out.result.cachePrefix, 'ok');
      expect(out.result.noCleanup, isFalse);
    });

    test('is silent for a YAML file with only known keys', () async {
      final out = await parseWith('''
prefix: shop
keep-maps: true
theme: dark
color: "#112233"
min-progress: 5
max-progress: 80
''');
      expect(out.stderr, isEmpty);
    });

    test('warns about a YAML key with no value', () async {
      // An unquoted # starts a comment, so the colour silently vanished.
      final out = await parseWith('color: #fff\n');
      expect(out.stderr, contains('"color" has no value'));
      expect(out.stderr, contains('quote'));
      expect(out.result.color, '#25D366');
    });

    test('fails when a named YAML is not a mapping', () async {
      expect(
        () => parseWith('- prefix\n- shop\n'),
        throwsA(isA<FormatException>()),
      );
    });

    test('fails when an explicit --config does not exist', () async {
      // `--config=sw-prod.yaml` with a typo in it used to warn and then
      // deploy with the prefix, the categories and the branding of an app
      // nobody configured.
      final missing = p.join(tempDir.path, 'ci', 'sw.yaml');
      expect(
        () => GeneratorConfig.parse(['--config=$missing']),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('does not exist'),
          ),
        ),
      );
    });

    group('theme', () {
      test('is matched case-insensitively and normalised', () async {
        final out = await captureOutput(
          () => GeneratorConfig.parse(const ['--theme=Dark']),
        );
        expect(out.result.theme, 'dark');
        expect(out.stderr, isEmpty);
      });

      test('an unknown theme warns and passes through', () async {
        final out = await captureOutput(
          () => GeneratorConfig.parse(const ['--theme=system']),
        );
        expect(out.result.theme, 'system');
        expect(out.stderr, contains('Warning: theme "system"'));
      });
    });

    // Issue #38: the generated artifacts must be able to keep quiet in
    // production, and the setting has to travel through every channel the
    // other options do.
    // Audit #30, item 3.6: `*` does not cross `/` in package:glob, so
    // `--ignore="*.png"` quietly covered only the top level of the build.
    group('segment-only globs', () {
      test('are warned about, and still work as written', () async {
        final out = await captureOutput(
          () => GeneratorConfig.parse(const ['--ignore=*.png']),
        );
        expect(out.result.ignoreGlobs, {'*.png'});
        expect(out.stderr, contains('matches only the top level'));
        expect(out.stderr, contains('**/*.png'));
      });

      test('are quiet when the pattern already crosses directories', () async {
        for (final pattern in ['**/*.png', '**.png', 'assets/*.png', '*']) {
          final out = await captureOutput(
            () => GeneratorConfig.parse(['--ignore=$pattern']),
          );
          expect(out.stderr, isEmpty, reason: pattern);
        }
      });

      test('name the YAML key they came from', () async {
        final out = await parseWith('ignore: "*.png"\n');
        expect(out.stderr, contains('ignore="*.png"'));
        expect(out.stderr, contains('sw.yaml'));
      });
    });

    // Audit #30, section 7: the flag was documented as "reserved" and did
    // nothing, which reads as if it does something.
    group('--comments', () {
      test('warns when it is switched on', () async {
        final out = await captureOutput(
          () => GeneratorConfig.parse(const ['--comments']),
        );
        expect(out.result.comments, isTrue);
        expect(out.stderr, contains('--comments has no effect'));
      });

      test('is quiet when it is not', () async {
        final out = await captureOutput(() => GeneratorConfig.parse(const []));
        expect(out.result.comments, isFalse);
        expect(out.stderr, isEmpty);
      });
    });

    group('log level', () {
      test('defaults to info', () async {
        final out = await captureOutput(() => GeneratorConfig.parse(const []));
        expect(out.result.logLevel, 'info');
        expect(out.stderr, isEmpty);
      });

      test('is taken from the CLI', () async {
        final out = await captureOutput(
          () => GeneratorConfig.parse(const ['--log-level=silent']),
        );
        expect(out.result.logLevel, 'silent');
        expect(out.stderr, isEmpty);
      });

      test('is normalised to one spelling', () async {
        final out = await captureOutput(
          () => GeneratorConfig.parse(const ['--log-level=WARN']),
        );
        expect(out.result.logLevel, 'warn');
      });

      test('is read from the YAML config', () async {
        final out = await parseWith('log-level: error\n');
        expect(out.result.logLevel, 'error');
        expect(out.stderr, isEmpty);
      });

      test('a CLI value wins over the YAML one', () async {
        final out = await parseWith('log-level: silent\n', const [
          '--log-level=info',
        ]);
        expect(out.result.logLevel, 'info');
      });

      test('an unknown level from the CLI fails, naming the flag', () {
        expect(
          () => GeneratorConfig.parse(const ['--log-level=quiet']),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              allOf(
                contains('--log-level="quiet"'),
                contains('silent, error, warn, info'),
              ),
            ),
          ),
        );
      });

      test('an unknown level in the YAML fails, naming the file', () async {
        await expectLater(
          parseWith('log-level: quiet\n'),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              allOf(
                contains('log-level="quiet"'),
                contains('sw.yaml'),
                contains('silent, error, warn, info'),
              ),
            ),
          ),
        );
      });

      test('validate() rejects a level built in code', () {
        const config = GeneratorConfig(
          inputDir: 'build/web',
          version: '',
          logLevel: 'quiet',
        );
        expect(
          config.validate,
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              contains('--log-level="quiet"'),
            ),
          ),
        );
      });
    });

    group('color', () {
      for (final ok in ['#fff', '#A1b2C3', '#11223344']) {
        test('accepts $ok silently', () async {
          final out = await captureOutput(
            () => GeneratorConfig.parse(['--color=$ok']),
          );
          expect(out.result.color, ok);
          expect(out.stderr, isEmpty);
        });
      }

      for (final bad in ['teal', 'rgb(1,2,3)', '#12345', '123456']) {
        test('warns about $bad and passes it through', () async {
          final out = await captureOutput(
            () => GeneratorConfig.parse(['--color=$bad']),
          );
          expect(out.result.color, bad);
          expect(out.stderr, contains('Warning: color "$bad"'));
        });
      }
    });

    group('progress range', () {
      test('warns when min-progress exceeds max-progress', () async {
        final out = await captureOutput(
          () => GeneratorConfig.parse(const [
            '--min-progress=95',
            '--max-progress=90',
          ]),
        );
        expect(out.result.minProgress, 95);
        expect(out.result.maxProgress, 90);
        expect(out.stderr, contains('min-progress (95)'));
      });

      test('warns when a bound is outside 0..100', () async {
        final out = await captureOutput(
          () => GeneratorConfig.parse(const [
            '--min-progress=-5',
            '--max-progress=150',
          ]),
        );
        expect(out.result.maxProgress, 150);
        expect(out.stderr, contains('max-progress (150)'));
        expect(out.stderr, contains('min-progress (-5)'));
      });

      test('is silent for a valid range', () async {
        final out = await captureOutput(
          () => GeneratorConfig.parse(const [
            '--min-progress=0',
            '--max-progress=100',
          ]),
        );
        expect(out.stderr, isEmpty);
      });
    });
  });

  group('GeneratorConfig.parse YAML values', () {
    late io.Directory tempDir;

    setUp(() {
      tempDir = io.Directory.systemTemp.createTempSync('sw-config-yaml-');
    });

    tearDown(() => tempDir.deleteSync(recursive: true));

    GeneratorConfig parseYaml(String content, [List<String> args = const []]) {
      final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
        ..writeAsStringSync(content);
      return GeneratorConfig.parse(['--config=${yaml.path}', ...args]);
    }

    Matcher formatError(String message) => throwsA(
      isA<FormatException>().having(
        (e) => e.message,
        'message',
        contains(message),
      ),
    );

    test('accepts lists for every glob option', () {
      final config = parseYaml('''
glob: ["**.js", "assets/**"]
no-glob:
  - "**.map"
  - assets/NOTICES
core: [assets/critical/**]
required: [a.json, b.json]
optional: ["**.part.js"]
ignore:
  - assets/video/**
''');
      // Each used to be one glob, "[**.js, assets/**]": a character class.
      expect(config.includeGlobs, {'**.js', 'assets/**'});
      expect(config.excludeGlobs, {'**.map', 'assets/NOTICES'});
      expect(config.coreGlobs, {'assets/critical/**'});
      expect(config.requiredGlobs, {'a.json', 'b.json'});
      expect(config.optionalGlobs, {'**.part.js'});
      expect(config.ignoreGlobs, {'assets/video/**'});
    });

    test('splits list items that hold several patterns', () {
      final config = parseYaml('glob: ["a/**; b/**", c/**]\n');
      expect(config.includeGlobs, {'a/**', 'b/**', 'c/**'});
    });

    test('an empty list selects nothing extra', () {
      expect(parseYaml('core: []\n').coreGlobs, isEmpty);
    });

    test('rejects a mapping for a glob option', () {
      expect(
        () => parseYaml('ignore:\n  video: assets/video/**\n'),
        formatError(
          '"ignore" in ${p.join(tempDir.path, 'sw.yaml')} is a '
          'mapping, but it takes a string or a list of strings',
        ),
      );
    });

    test('rejects a nested list in a glob option', () {
      expect(
        () => parseYaml('glob:\n  - [a, b]\n'),
        formatError('found a nested list at line 2'),
      );
    });

    test('rejects an empty list item', () {
      expect(
        () => parseYaml('glob:\n  - a\n  -\n'),
        formatError('found an empty item at line 3'),
      );
    });

    test('rejects a list for a single-value option', () {
      expect(() => parseYaml('title: [a, b]\n'), formatError('"title" in'));
      expect(
        () => parseYaml('keep-maps: [true]\n'),
        formatError('"keep-maps" in'),
      );
    });

    test('rejects a mapping for a single-value option', () {
      expect(
        () => parseYaml('prefix:\n  a: b\n'),
        formatError('takes a single value'),
      );
    });

    test('keeps the text of a plain scalar', () {
      final config = parseYaml('''
version: 1.10
title: 0x1F
prefix: 1e3
logo: 010.png
''');
      // Read as numbers, these became "1.1", "31" and "1000.0".
      expect(config.version, '1.10');
      expect(config.title, '0x1F');
      expect(config.cachePrefix, '1e3');
      expect(config.logo, '010.png');
    });

    test('keeps the value of a quoted or block scalar', () {
      final config = parseYaml('''
version: "1.10"
title: 'It''s mine'
color: "#112233"
logo: |-
  icons/logo.png
''');
      expect(config.version, '1.10');
      expect(config.title, "It's mine");
      expect(config.color, '#112233');
      expect(config.logo, 'icons/logo.png');
    });

    test('still reads numbers and booleans', () {
      final config = parseYaml('''
min-progress: 10
max-progress: 80
keep-maps: True
no-cleanup: no
''');
      expect(config.minProgress, 10);
      expect(config.maxProgress, 80);
      expect(config.keepMaps, isTrue);
      expect(config.noCleanup, isFalse);
    });

    test('an invalid integer names the YAML key and file', () {
      expect(
        () => parseYaml('min-progress: 1.5\n'),
        formatError(
          'min-progress="1.5" (in ${p.join(tempDir.path, 'sw.yaml')}) is not '
          'a valid integer',
        ),
      );
    });

    test('an invalid glob names the YAML key', () {
      expect(
        () => parseYaml('core: ["ok/**", "["]\n'),
        formatError(
          'core (in ${p.join(tempDir.path, 'sw.yaml')}) contains "["',
        ),
      );
    });

    test('an output name with a directory names the YAML key', () {
      expect(
        () => parseYaml('output: js/sw.js\n'),
        formatError('output="js/sw.js" (in'),
      );
    });
  });

  group('GeneratorConfig.parse validation', () {
    Matcher formatError(String message) => throwsA(
      isA<FormatException>().having(
        (e) => e.message,
        'message',
        contains(message),
      ),
    );

    test('rejects an invalid glob, naming the CLI flag', () {
      for (final option in [
        'glob',
        'no-glob',
        'core',
        'required',
        'optional',
        'ignore',
      ]) {
        expect(
          () => GeneratorConfig.parse(['--$option=a/**;{b']),
          formatError('--$option contains "{b"'),
          reason: option,
        );
      }
    });

    test('an invalid integer names the CLI flag', () {
      expect(
        () => GeneratorConfig.parse(const ['--min-progress=x']),
        formatError('--min-progress="x" is not a valid integer'),
      );
    });

    for (final name in [
      'js/sw.js',
      r'js\sw.js',
      '../sw.js',
      '..',
      '.',
      '/abs/sw.js',
      r'C:\sw.js',
      'C:sw.js',
      '',
    ]) {
      test('rejects the output name "$name"', () {
        expect(
          () => GeneratorConfig.parse(['--output=$name']),
          formatError('--output="$name"'),
        );
        expect(
          () => GeneratorConfig.parse(['--bootstrap-output=$name']),
          formatError('--bootstrap-output="$name"'),
        );
      });
    }

    test('rejects the same name for both outputs', () {
      expect(
        () => GeneratorConfig.parse(const ['--bootstrap-output=sw.js']),
        formatError('both be written to "sw.js"'),
      );
    });

    // Writing the worker as `flutter_service_worker.js` — the name the
    // browsers already have registered, so a natural migration choice —
    // used to succeed, print "Done!", and leave nothing behind: cleanup
    // deletes Flutter's loader files after the outputs are written.
    for (final name in [
      'flutter_service_worker.js',
      'flutter_bootstrap.js',
      'flutter.js',
      'Flutter.js',
      'main.dart.js',
      'index.html',
    ]) {
      test('rejects the output name "$name", which the run would delete', () {
        expect(
          () => GeneratorConfig.parse(['--output=$name']),
          formatError('--output="$name"'),
        );
        expect(
          () => GeneratorConfig.parse(['--bootstrap-output=$name']),
          formatError('--bootstrap-output="$name"'),
        );
      });
    }

    // The prefix names every cache the worker keeps and scopes the
    // loading screen's "clear the cache and reload". An empty one made
    // that button delete every cache on the origin, another app's
    // included.
    for (final prefix in ['', '   ', 'app/cache', r'app\cache', 'app ']) {
      test('rejects the cache prefix "$prefix"', () {
        expect(
          () => GeneratorConfig.parse(['--prefix=$prefix']),
          formatError('--prefix="$prefix"'),
        );
      });
    }

    test('accepts a plain cache prefix', () {
      expect(
        GeneratorConfig.parse(const ['--prefix=shop-admin']).cachePrefix,
        'shop-admin',
      );
    });

    test('accepts plain output names', () {
      final config = GeneratorConfig.parse(const [
        '--output=service-worker.js',
        '--bootstrap-output=boot.v2.js',
      ]);
      expect(config.swOutput, 'service-worker.js');
      expect(config.bootstrapOutput, 'boot.v2.js');
    });

    test('rejects versions that collide with cache names', () {
      expect(
        () => GeneratorConfig.parse(const ['--version=manifest']),
        formatError('--version="manifest"'),
      );
      expect(
        () => GeneratorConfig.parse(const ['--version=temp-abc']),
        formatError('starts with "temp-"'),
      );
      expect(
        () => GeneratorConfig.parse(const ['--version=v1-manifest']),
        formatError('ends with "-manifest"'),
      );
    });

    test('accepts versions that only resemble a cache name', () {
      for (final version in [
        'manifests',
        'v-temp-1',
        'temp',
        'Manifest',
        'manifest-2',
        'v1manifest',
      ]) {
        expect(GeneratorConfig.parse(['--version=$version']).version, version);
      }
    });
  });
}
