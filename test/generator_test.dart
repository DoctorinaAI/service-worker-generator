import 'dart:convert';
import 'dart:io' as io;

import 'package:crypto/crypto.dart' as crypto;
import 'package:path/path.dart' as p;
import 'package:sw/src/config.dart';
import 'package:sw/src/generator.dart';
import 'package:test/test.dart';

/// End-to-end `generate()` tests over a synthetic build directory.
///
/// The suites under `test/integration/` need a real `flutter build web`, so
/// the invariants that bind the manifest to the bytes on disk had no home
/// that runs everywhere. These fixtures are the smallest input `generate()`
/// accepts.
void main() {
  late io.Directory dir;

  setUp(() {
    dir = io.Directory.systemTemp.createTempSync('sw_generator_test');
  });

  tearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });

  void writeBuild({String indexHtml = _indexWithPlaceholder}) {
    io.File(
      p.join(dir.path, 'flutter_bootstrap.js'),
    ).writeAsStringSync(_flutterBootstrap);
    io.File(p.join(dir.path, 'flutter.js')).writeAsStringSync('// loader');
    io.File(p.join(dir.path, 'index.html')).writeAsStringSync(indexHtml);
    io.File(
      p.join(dir.path, 'main.dart.js'),
    ).writeAsStringSync('console.log("app");');
    io.File(p.join(dir.path, 'manifest.json')).writeAsStringSync('{}');
  }

  GeneratorConfig config({bool noCleanup = false}) =>
      GeneratorConfig(inputDir: dir.path, version: '', noCleanup: noCleanup);

  String swVersion() {
    final sw = io.File(p.join(dir.path, 'sw.js')).readAsStringSync();
    final match = RegExp(r'"version":\s*"([^"]+)"').firstMatch(sw);
    expect(match, isNotNull, reason: 'sw.js should carry an injected version');
    return match!.group(1)!;
  }

  /// The injected manifest entry for the app shell, read back out of the
  /// generated worker — the only copy that ships.
  Map<String, dynamic> shellEntry() {
    final sw = io.File(p.join(dir.path, 'sw.js')).readAsStringSync();
    final match = RegExp(r'"index\.html":(\{[^}]*\})').firstMatch(sw);
    expect(match, isNotNull, reason: 'sw.js should carry a shell entry');
    return jsonDecode(match!.group(1)!) as Map<String, dynamic>;
  }

  test(
    'records the shell hash and size of the bytes actually shipped',
    () async {
      writeBuild();
      await generate(config());

      final shell = io.File(p.join(dir.path, 'index.html'));
      final bytes = shell.readAsBytesSync();
      final entry = shellEntry();

      // The generator stamps the version into index.html, so an entry hashed
      // before that substitution describes a file the origin never serves.
      expect(shell.readAsStringSync(), isNot(contains('{{sw_version}}')));
      expect(entry['hash'], crypto.md5.convert(bytes).toString());
      expect(entry['size'], bytes.length);
    },
  );

  test('leaves index.html untouched under --no-cleanup', () async {
    writeBuild();
    await generate(config(noCleanup: true));

    final shell = io.File(p.join(dir.path, 'index.html'));
    // The flag exists to leave the input tree alone. Substituting anyway
    // would both break that contract and make the derived version depend on
    // a file this run rewrote.
    expect(shell.readAsStringSync(), contains('{{sw_version}}'));
    final entry = shellEntry();
    final digest = crypto.md5.convert(shell.readAsBytesSync()).toString();
    expect(entry['hash'], digest);
  });

  test('derives the same version across --no-cleanup re-runs', () async {
    writeBuild();
    await generate(config(noCleanup: true));
    final first = swVersion();

    // The documented dev loop re-runs the generator in place. Byte-identical
    // input must keep the version, or every client takes a spurious update.
    await generate(config(noCleanup: true));
    expect(swVersion(), first);

    await generate(config(noCleanup: true));
    expect(swVersion(), first);
  });

  test('still reacts to a change in any hashed resource', () async {
    writeBuild();
    await generate(config(noCleanup: true));
    final first = swVersion();

    io.File(
      p.join(dir.path, 'main.dart.js'),
    ).writeAsStringSync('console.log("app v2");');
    await generate(config(noCleanup: true));
    final second = swVersion();
    expect(second, isNot(first));

    // Including the shell — idempotence must not be bought by making the
    // version blind to the app shell.
    io.File(
      p.join(dir.path, 'index.html'),
    ).writeAsStringSync('<html><!-- edited --></html>');
    await generate(config(noCleanup: true));
    expect(swVersion(), isNot(second));
  });

  test(
    'keeps both files of every CanvasKit variant the bootstrap loads',
    () async {
      writeBuild();
      // Flutter's canvaskit renderer output, including the Chromium variant
      // and a file no variant uses.
      const kept = [
        'canvaskit/canvaskit.js',
        'canvaskit/canvaskit.wasm',
        'canvaskit/chromium/canvaskit.js',
        'canvaskit/chromium/canvaskit.wasm',
      ];
      for (final path in [...kept, 'canvaskit/unused.wasm']) {
        io.File(p.join(dir.path, path))
          ..createSync(recursive: true)
          ..writeAsStringSync('// $path');
      }

      await generate(config());

      // A --no-web-resources-cdn build loads the variant from canvaskit/, so
      // pruning half of it breaks the app on the browsers that pick it.
      for (final path in kept) {
        expect(
          io.File(p.join(dir.path, path)).existsSync(),
          isTrue,
          reason: path,
        );
      }
      expect(
        io.File(p.join(dir.path, 'canvaskit/unused.wasm')).existsSync(),
        isFalse,
      );
    },
  );
}

const String _flutterBootstrap = '''
_flutter.buildConfig = {"engineRevision":"abc123","builds":[{"compileTarget":"dart2js","renderer":"canvaskit","mainJsPath":"main.dart.js"}]};
''';

const String _indexWithPlaceholder = '''
<html><head><meta name="sw" content="{{sw_version}}"></head>
<body><script defer data-sw-bootstrap src="bootstrap.js"></script></body></html>
''';
