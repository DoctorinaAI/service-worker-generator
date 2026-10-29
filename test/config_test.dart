import 'dart:io' as io;

import 'package:path/path.dart' as p;
import 'package:sw/src/config.dart';
import 'package:test/test.dart';

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

    test('corrupt YAML falls through to defaults without throwing', () async {
      final tempDir = await io.Directory.systemTemp.createTemp('sw-config-');
      try {
        final yaml = io.File(p.join(tempDir.path, 'sw.yaml'))
          ..writeAsStringSync(': : not valid yaml : :\n');
        final config = GeneratorConfig.parse(['--config=${yaml.path}']);
        // Falls back to defaults.
        expect(config.cachePrefix, 'app-cache');
      } finally {
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
}
