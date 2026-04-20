@Tags(['integration'])
library;

import 'dart:io' as io;

import 'package:path/path.dart' as p;
import 'package:sw/src/config.dart';
import 'package:sw/src/generator.dart';
import 'package:test/test.dart';

/// Copy a directory recursively.
void _copyDirectory(io.Directory source, io.Directory target) {
  if (!target.existsSync()) target.createSync(recursive: true);
  for (final entity in source.listSync(followLinks: false)) {
    final name = p.basename(entity.path);
    if (entity is io.File) {
      entity.copySync(p.join(target.path, name));
    } else if (entity is io.Directory) {
      _copyDirectory(entity, io.Directory(p.join(target.path, name)));
    }
  }
}

void main() {
  late io.Directory tempDir;
  final exampleBuild = io.Directory('example/build/web');

  setUpAll(() {
    if (!exampleBuild.existsSync()) {
      fail(
        'example/build/web/ does not exist. '
        'Run "cd example && flutter build web" first.',
      );
    }
  });

  setUp(() {
    tempDir = io.Directory.systemTemp.createTempSync('sw_rebuild_test_');
    _copyDirectory(exampleBuild, tempDir);
  });

  tearDown(() {
    tempDir.deleteSync(recursive: true);
  });

  test('rebuild with different version produces different output', () async {
    // First build
    final config1 = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'version-1',
      cachePrefix: 'rebuild-test',
      noCleanup: true,
    );
    await generate(config1);

    final sw1 = io.File(p.join(tempDir.path, 'sw.js')).readAsStringSync();
    final bootstrap1 = io.File(
      p.join(tempDir.path, 'bootstrap.js'),
    ).readAsStringSync();

    // Second build with different version
    final config2 = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'version-2',
      cachePrefix: 'rebuild-test',
      noCleanup: true,
    );
    await generate(config2);

    final sw2 = io.File(p.join(tempDir.path, 'sw.js')).readAsStringSync();
    final bootstrap2 = io.File(
      p.join(tempDir.path, 'bootstrap.js'),
    ).readAsStringSync();

    // Versions should differ
    expect(sw1, isNot(equals(sw2)));
    expect(bootstrap1, isNot(equals(bootstrap2)));

    // Each should contain its own version
    expect(sw1, contains('"version":"version-1"'));
    expect(sw2, contains('"version":"version-2"'));
    expect(bootstrap1, contains('"swVersion":"version-1"'));
    expect(bootstrap2, contains('"swVersion":"version-2"'));
  });

  test('rebuild with different prefix produces different output', () async {
    final config1 = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'same-version',
      cachePrefix: 'prefix-alpha',
      noCleanup: true,
    );
    await generate(config1);

    final sw1 = io.File(p.join(tempDir.path, 'sw.js')).readAsStringSync();

    final config2 = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'same-version',
      cachePrefix: 'prefix-beta',
      noCleanup: true,
    );
    await generate(config2);

    final sw2 = io.File(p.join(tempDir.path, 'sw.js')).readAsStringSync();

    expect(sw1, contains('"cachePrefix":"prefix-alpha"'));
    expect(sw2, contains('"cachePrefix":"prefix-beta"'));
    expect(sw1, isNot(equals(sw2)));
  });

  test('rebuild preserves manifest hashes for unchanged files', () async {
    final config1 = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'v1',
      noCleanup: true,
    );
    await generate(config1);

    final sw1 = io.File(p.join(tempDir.path, 'sw.js')).readAsStringSync();

    // Extract a hash from the first build (main.dart.js hash)
    final hashPattern = RegExp(r'"main\.dart\.js":\{[^}]*"hash":"([^"]+)"');
    final match1 = hashPattern.firstMatch(sw1);
    expect(match1, isNotNull);
    final hash1 = match1!.group(1);

    // Rebuild without changing any files
    final config2 = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'v2',
      noCleanup: true,
    );
    await generate(config2);

    final sw2 = io.File(p.join(tempDir.path, 'sw.js')).readAsStringSync();

    final match2 = hashPattern.firstMatch(sw2);
    expect(match2, isNotNull);
    final hash2 = match2!.group(1);

    // Hash should be the same since file content didn't change
    expect(hash1, equals(hash2));
  });

  test('rebuild after cleanup still works', () async {
    // First build WITH cleanup (removes flutter_bootstrap.js)
    final config1 = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'v1',
      noCleanup: false,
    );
    await generate(config1);

    // flutter_bootstrap.js should be gone
    expect(
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).existsSync(),
      isFalse,
    );

    // Second build should fail because flutter_bootstrap.js
    // is needed to extract build config
    final config2 = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'v2',
      noCleanup: true,
    );

    expect(
      () => generate(config2),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('flutter_bootstrap.js not found'),
        ),
      ),
    );
  });
}
