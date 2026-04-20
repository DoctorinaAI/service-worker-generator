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
    tempDir = io.Directory.systemTemp.createTempSync('sw_build_test_');
    _copyDirectory(exampleBuild, tempDir);
  });

  tearDown(() {
    tempDir.deleteSync(recursive: true);
  });

  test('generates sw.js and bootstrap.js', () async {
    final config = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'test-v1',
      cachePrefix: 'test-app',
    );

    await generate(config);

    final swFile = io.File(p.join(tempDir.path, 'sw.js'));
    final bootstrapFile = io.File(p.join(tempDir.path, 'bootstrap.js'));

    expect(swFile.existsSync(), isTrue);
    expect(bootstrapFile.existsSync(), isTrue);
  });

  test('sw.js contains injected config', () async {
    final config = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'build-test-123',
      cachePrefix: 'my-prefix',
    );

    await generate(config);

    final swContent = io.File(p.join(tempDir.path, 'sw.js')).readAsStringSync();

    expect(swContent, contains('"cachePrefix":"my-prefix"'));
    expect(swContent, contains('"version":"build-test-123"'));
    // Should contain manifest with core resources
    expect(swContent, contains('"main.dart.js"'));
    expect(swContent, contains('"category":"core"'));
    // Should not contain placeholder
    expect(swContent, isNot(contains('__INJECT_SW_CONFIG__')));
  });

  test('bootstrap.js contains injected build config', () async {
    final config = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'bs-test-456',
      cachePrefix: 'bs-prefix',
    );

    await generate(config);

    final content = io.File(
      p.join(tempDir.path, 'bootstrap.js'),
    ).readAsStringSync();

    expect(content, contains('"engineRevision"'));
    expect(content, contains('"swVersion":"bs-test-456"'));
    expect(content, contains('"swFilename":"sw.js"'));
    expect(content, contains('"builds"'));
    // Should not contain placeholder
    expect(content, isNot(contains('__INJECT_BOOTSTRAP_CONFIG__')));
  });

  test('cleanup removes Flutter files', () async {
    // Verify preconditions
    expect(
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).existsSync(),
      isTrue,
    );
    expect(
      io.File(p.join(tempDir.path, 'flutter_service_worker.js')).existsSync(),
      isTrue,
    );
    expect(io.File(p.join(tempDir.path, 'version.json')).existsSync(), isTrue);

    final config = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'cleanup-test',
    );

    await generate(config);

    expect(
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).existsSync(),
      isFalse,
    );
    expect(
      io.File(p.join(tempDir.path, 'flutter_service_worker.js')).existsSync(),
      isFalse,
    );
    expect(io.File(p.join(tempDir.path, 'version.json')).existsSync(), isFalse);
  });

  test('--no-cleanup preserves Flutter files', () async {
    final config = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'no-cleanup-test',
      noCleanup: true,
    );

    await generate(config);

    expect(
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).existsSync(),
      isTrue,
    );
  });

  test('manifest excludes ignored files', () async {
    final config = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'manifest-test',
    );

    await generate(config);

    final swContent = io.File(p.join(tempDir.path, 'sw.js')).readAsStringSync();

    // Ignored files should not appear in manifest
    expect(swContent, isNot(contains('"assets/NOTICES"')));
    // index.html, sw.js, bootstrap.js are never in manifest
    // (they're in the ignore category)
  });

  test('categorizes resources correctly', () async {
    final config = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'cat-test',
      noCleanup: true,
    );

    await generate(config);

    final swContent = io.File(p.join(tempDir.path, 'sw.js')).readAsStringSync();

    // Extract manifest JSON from the sw.js file
    // The config is injected as JSON, find it
    expect(swContent, contains('"category":"core"'));
    expect(swContent, contains('"category":"required"'));
    expect(swContent, contains('"category":"optional"'));
  });

  test('custom output filenames work', () async {
    final config = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'custom-out',
      swOutput: 'service-worker.js',
      bootstrapOutput: 'boot.js',
      noCleanup: true,
    );

    await generate(config);

    expect(
      io.File(p.join(tempDir.path, 'service-worker.js')).existsSync(),
      isTrue,
    );
    expect(io.File(p.join(tempDir.path, 'boot.js')).existsSync(), isTrue);
  });

  test('generated files are non-trivial size', () async {
    final config = GeneratorConfig(
      inputDir: tempDir.path,
      version: 'size-test',
      noCleanup: true,
    );

    await generate(config);

    final swSize = io.File(p.join(tempDir.path, 'sw.js')).lengthSync();
    final bootstrapSize = io.File(
      p.join(tempDir.path, 'bootstrap.js'),
    ).lengthSync();

    // SW should be at least 5 KB (template + manifest)
    expect(swSize, greaterThan(5000));
    // Bootstrap should be at least 10 KB (template + config)
    expect(bootstrapSize, greaterThan(10000));
  });
}
