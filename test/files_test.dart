import 'dart:io' as io;

import 'package:path/path.dart' as p;
import 'package:sw/src/files.dart';
import 'package:test/test.dart';

void main() {
  group('pathToUrl', () {
    test('passes through forward-slash paths (modulo normalize)', () {
      expect(
        pathToUrl('assets/AssetManifest.json'),
        'assets/AssetManifest.json',
      );
      expect(pathToUrl('./a/./b/../c'), 'a/c');
    });
  });

  group('md5', () {
    test('produces the known hex digest for fixed content', () async {
      final tempDir = await io.Directory.systemTemp.createTemp('sw-md5-');
      try {
        final file = io.File(p.join(tempDir.path, 'hello.txt'))
          ..writeAsStringSync('hello');
        final hash = await md5(file);
        expect(hash, '5d41402abc4b2a76b9719d911017c592');
      } finally {
        tempDir.deleteSync(recursive: true);
      }
    });
  });

  group('filesInDirectory', () {
    test('returns relative URL-style paths keyed to their File', () async {
      final root = await io.Directory.systemTemp.createTemp('sw-files-');
      try {
        io.File(p.join(root.path, 'a.js')).writeAsStringSync('a');
        final assets = io.Directory(p.join(root.path, 'assets'))
          ..createSync();
        io.File(p.join(assets.path, 'b.json')).writeAsStringSync('b');

        final files = filesInDirectory(root);
        expect(files.keys, containsAll(['a.js', 'assets/b.json']));
      } finally {
        root.deleteSync(recursive: true);
      }
    });

    test('respects include/exclude globs', () async {
      final root = await io.Directory.systemTemp.createTemp('sw-files-');
      try {
        io.File(p.join(root.path, 'main.dart.js')).writeAsStringSync('a');
        io.File(p.join(root.path, 'main.dart.js.map')).writeAsStringSync('b');
        io.File(p.join(root.path, 'README.md')).writeAsStringSync('c');

        final files = filesInDirectory(
          root,
          include: const {'**.js'},
          exclude: const {'**.map'},
        );
        expect(files.keys.toList(), ['main.dart.js']);
      } finally {
        root.deleteSync(recursive: true);
      }
    });

    test('returns empty map when directory does not exist', () {
      final dir = io.Directory('/this/should/not/exist/hopefully-xyz');
      expect(filesInDirectory(dir), isEmpty);
    });
  });
}
