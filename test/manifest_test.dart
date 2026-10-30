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

      // The app shell is pre-cached, so it must be in the manifest —
      // that is what lets an offline navigation resolve.
      expect(manifest.containsKey('index.html'), isTrue);
      expect(manifest['index.html']!.category, ResourceCategory.required);
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

  group('generateManifest hashing', () {
    late io.Directory tempDir;

    setUp(() {
      tempDir = io.Directory.systemTemp.createTempSync('sw_hash_test_');
    });

    tearDown(() {
      // Restore permissions so the directory can be removed.
      for (final f in tempDir.listSync(recursive: true).whereType<io.File>()) {
        if (!io.Platform.isWindows) {
          io.Process.runSync('chmod', ['644', f.path]);
        }
      }
      tempDir.deleteSync(recursive: true);
    });

    test('never reads a file that categorises as ignore', () async {
      io.File(p.join(tempDir.path, 'main.dart.js')).writeAsStringSync('main');
      // An unreadable ignored file: the old pipeline read and hashed every
      // file before dropping ignore entries, so this threw.
      final secret = io.File(p.join(tempDir.path, 'main.dart.js.map'))
        ..writeAsStringSync('map');
      io.Process.runSync('chmod', ['000', secret.path]);

      final manifest = await generateManifest(
        directory: tempDir,
        categorizer: FileCategorizer(),
        includeGlobs: {'**'},
        excludeGlobs: {},
      );
      expect(manifest.keys, ['main.dart.js']);
    }, testOn: '!windows');

    test('produces the same manifest as before hashing was skipped', () async {
      writeHashFixture(tempDir);
      final manifest = await generateManifest(
        directory: tempDir,
        categorizer: FileCategorizer(),
        includeGlobs: {'**'},
        excludeGlobs: {},
      );
      // Captured from the pipeline that hashed every file first.
      expect(canonicalManifest(manifest), _goldenManifest);
    });

    test('reports each ignored file with its size', () async {
      writeHashFixture(tempDir);
      final ignored = <String, int>{};
      await generateManifest(
        directory: tempDir,
        categorizer: FileCategorizer(),
        includeGlobs: {'**'},
        excludeGlobs: {},
        onIgnored: (path, size) => ignored[path] = size,
      );
      expect(ignored, {
        'assets/NOTICES': 7,
        'assets/big.png': 600 * 1024,
        'data.txt': 4,
        'main.dart.js.map': 3,
        'main.dart.js_1.part.js': 4,
      });
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

/// A build with one file per category, including a multi-chunk font and
/// files that are ignored for every reason the categoriser has.
void writeHashFixture(io.Directory dir) {
  void write(String path, List<int> bytes) => io.File(p.join(dir.path, path))
    ..createSync(recursive: true)
    ..writeAsBytesSync(bytes);
  List<int> pattern(int length) => List<int>.generate(length, (i) => i % 251);

  write('main.dart.js', utf8.encode('main code'));
  write('index.html', utf8.encode('<html></html>'));
  write('assets/FontManifest.json', utf8.encode('[]'));
  write('assets/fonts/Icons.ttf', pattern(600 * 1024 + 17));
  write('assets/icon.png', pattern(1000));
  write('assets/big.png', pattern(600 * 1024));
  write('assets/NOTICES', utf8.encode('notices'));
  write('main.dart.js.map', utf8.encode('map'));
  write('main.dart.js_1.part.js', utf8.encode('part'));
  write('data.txt', utf8.encode('data'));
}

/// One line per entry, sorted, so directory listing order does not matter.
String canonicalManifest(Map<String, ResourceEntry> manifest) {
  final keys = manifest.keys.toList()..sort();
  return [
    for (final key in keys) '$key ${jsonEncode(manifest[key]!.toJson())}',
  ].join('\n');
}

/// Captured from the pipeline that hashed every file before categorising.
final String _goldenManifest = canonicalManifest({
  for (final (path, size, hash, category) in const [
    (
      'assets/FontManifest.json',
      2,
      'd751713988987e9331980363e24189ce',
      ResourceCategory.required,
    ),
    (
      'assets/fonts/Icons.ttf',
      614417,
      '8b5c98bfb2794fed076a0edb477e926c',
      ResourceCategory.optional,
    ),
    (
      'assets/icon.png',
      1000,
      'a24f1e3ef66950e1327f210e3997ba2c',
      ResourceCategory.optional,
    ),
    (
      'index.html',
      13,
      'c83301425b2ad1d496473a5ff3d9ecca',
      ResourceCategory.required,
    ),
    (
      'main.dart.js',
      9,
      'bdd0027574a1e64ed76e4682b1d9dbc4',
      ResourceCategory.core,
    ),
  ])
    path: ResourceEntry(
      name: p.url.basename(path),
      size: size,
      hash: hash,
      category: category,
    ),
});
