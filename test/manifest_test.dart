import 'dart:convert';
import 'dart:io' as io;

import 'package:path/path.dart' as p;
import 'package:sw/src/categorizer.dart';
import 'package:sw/src/manifest.dart';
import 'package:test/test.dart';

void main() {
  group('ResourceEntry', () {
    test('toJson produces correct map', () {
      const entry = ResourceEntry(
        name: 'main.dart.js',
        size: 1024,
        hash: 'abc123',
        category: ResourceCategory.core,
      );

      final json = entry.toJson();
      expect(json['name'], 'main.dart.js');
      expect(json['size'], 1024);
      expect(json['hash'], 'abc123');
      expect(json['category'], 'core');
    });

    test('toJson uses category name', () {
      const entry = ResourceEntry(
        name: 'font.ttf',
        size: 500,
        hash: 'def',
        category: ResourceCategory.optional,
      );

      expect(entry.toJson()['category'], 'optional');
    });
  });

  group('generateManifest', () {
    late io.Directory tempDir;

    setUp(() {
      tempDir = io.Directory.systemTemp.createTempSync('sw_test_');
    });

    tearDown(() {
      tempDir.deleteSync(recursive: true);
    });

    test('scans files and categorizes them', () async {
      io.File(
        p.join(tempDir.path, 'main.dart.js'),
      ).writeAsStringSync('main code');
      io.File(
        p.join(tempDir.path, 'index.html'),
      ).writeAsStringSync('<html></html>');

      final assetsDir = io.Directory(p.join(tempDir.path, 'assets'))
        ..createSync();
      io.File(
        p.join(assetsDir.path, 'FontManifest.json'),
      ).writeAsStringSync('[]');

      final categorizer = FileCategorizer();
      final manifest = await generateManifest(
        directory: tempDir,
        categorizer: categorizer,
        includeGlobs: {'**'},
        excludeGlobs: {},
      );

      // main.dart.js should be core
      expect(manifest.containsKey('main.dart.js'), isTrue);
      expect(manifest['main.dart.js']!.category, ResourceCategory.core);

      // FontManifest.json should be required
      expect(manifest.containsKey('assets/FontManifest.json'), isTrue);
      expect(
        manifest['assets/FontManifest.json']!.category,
        ResourceCategory.required,
      );

      // index.html is ignored and should NOT be in manifest
      expect(manifest.containsKey('index.html'), isFalse);
    });

    test('excludes files matching exclude globs', () async {
      io.File(p.join(tempDir.path, 'main.dart.js')).writeAsStringSync('main');
      io.File(p.join(tempDir.path, 'test.json')).writeAsStringSync('{}');

      final categorizer = FileCategorizer();
      final manifest = await generateManifest(
        directory: tempDir,
        categorizer: categorizer,
        includeGlobs: {'**'},
        excludeGlobs: {'*.json'},
      );

      expect(manifest.containsKey('main.dart.js'), isTrue);
      expect(manifest.containsKey('test.json'), isFalse);
    });

    test('includes only matching include globs', () async {
      io.File(p.join(tempDir.path, 'main.dart.js')).writeAsStringSync('main');
      io.File(p.join(tempDir.path, 'data.txt')).writeAsStringSync('hello');

      final categorizer = FileCategorizer();
      final manifest = await generateManifest(
        directory: tempDir,
        categorizer: categorizer,
        includeGlobs: {'*.js'},
        excludeGlobs: {},
      );

      expect(manifest.containsKey('main.dart.js'), isTrue);
      expect(manifest.containsKey('data.txt'), isFalse);
    });

    test('computes MD5 hashes', () async {
      io.File(
        p.join(tempDir.path, 'main.dart.js'),
      ).writeAsStringSync('hello world');

      final categorizer = FileCategorizer();
      final manifest = await generateManifest(
        directory: tempDir,
        categorizer: categorizer,
        includeGlobs: {'**'},
        excludeGlobs: {},
      );

      final entry = manifest['main.dart.js']!;
      // MD5 of "hello world" is 5eb63bbbe01eeed093cb22bb8f5acdc3
      expect(entry.hash, '5eb63bbbe01eeed093cb22bb8f5acdc3');
    });
  });

  group('manifestToJson', () {
    test('serializes manifest to JSON string', () {
      final manifest = {
        'main.dart.js': const ResourceEntry(
          name: 'main.dart.js',
          size: 1024,
          hash: 'abc',
          category: ResourceCategory.core,
        ),
      };

      final jsonStr = manifestToJson(manifest);
      final decoded = jsonDecode(jsonStr) as Map<String, dynamic>;
      expect(decoded.containsKey('main.dart.js'), isTrue);
      expect(decoded['main.dart.js']['category'], 'core');
    });

    test('handles empty manifest', () {
      final jsonStr = manifestToJson({});
      expect(jsonStr, '{}');
    });
  });
}
