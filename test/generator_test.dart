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

  test('embeds flutter.js without its dangling source-map comment', () async {
    writeBuild();
    // Flutter's loader ends in an IIFE and a map that cleanup deletes.
    io.File(p.join(dir.path, 'flutter.js')).writeAsStringSync(
      '(function(){window.loader=1})()\n//# sourceMappingURL=flutter.js.map\n',
    );
    await generate(config());
    final bootstrap = io.File(
      p.join(dir.path, 'bootstrap.js'),
    ).readAsStringSync();
    expect(bootstrap, startsWith('(function(){window.loader=1})()\n;\n'));
    expect(bootstrap, isNot(contains('sourceMappingURL=flutter.js.map')));
  });

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

  group('rejects an incomplete build', () {
    test('without the build directory', () {
      dir.deleteSync(recursive: true);
      expect(
        generate(config()),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('Build directory not found'),
          ),
        ),
      );
    });

    test('without index.html', () {
      writeBuild();
      io.File(p.join(dir.path, 'index.html')).deleteSync();
      expect(
        generate(config()),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('index.html not found'),
          ),
        ),
      );
    });

    test('without an engine revision', () {
      writeBuild();
      io.File(
        p.join(dir.path, 'flutter_bootstrap.js'),
      ).writeAsStringSync('_flutter.buildConfig = {"builds":[]};');
      expect(
        generate(config()),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('missing engineRevision'),
          ),
        ),
      );
    });

    test('without flutter.js, before writing anything', () async {
      writeBuild();
      io.File(p.join(dir.path, 'flutter.js')).deleteSync();
      await expectLater(
        generate(config()),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('flutter.js not found'),
          ),
        ),
      );
      expect(io.File(p.join(dir.path, 'sw.js')).existsSync(), isFalse);
      expect(io.File(p.join(dir.path, 'bootstrap.js')).existsSync(), isFalse);
      expect(
        io.File(p.join(dir.path, 'flutter_bootstrap.js')).existsSync(),
        isTrue,
      );
    });
  });

  test('a second run over a cleaned directory fails loudly', () async {
    writeBuild();
    await generate(config());
    // Cleanup removed Flutter's files, so a re-run cannot silently derive a
    // version from a shell it already stamped.
    expect(generate(config()), throwsStateError);
  });

  test('a trailing line comment in flutter.js cannot swallow the ;', () async {
    writeBuild();
    io.File(
      p.join(dir.path, 'flutter.js'),
    ).writeAsStringSync('(function(){window.loader=1})()\n// trailing comment');
    await generate(config());
    final bootstrap = io.File(
      p.join(dir.path, 'bootstrap.js'),
    ).readAsStringSync();
    expect(bootstrap, contains('// trailing comment\n;\n'));
  });

  test('strips a CRLF source-map comment from flutter.js', () async {
    writeBuild();
    io.File(p.join(dir.path, 'flutter.js')).writeAsStringSync(
      '(function(){window.loader=1})()\r\n'
      '//# sourceMappingURL=flutter.js.map\r\n',
    );
    await generate(config());
    final bootstrap = io.File(
      p.join(dir.path, 'bootstrap.js'),
    ).readAsStringSync();
    expect(bootstrap, startsWith('(function(){window.loader=1})()\n;\n'));
    expect(bootstrap, isNot(contains('sourceMappingURL')));
  });

  test('uses a supplied version verbatim, in sw.js and the shell', () async {
    writeBuild();
    await generate(GeneratorConfig(inputDir: dir.path, version: '2026.10.29'));
    expect(swVersion(), '2026.10.29');
    expect(
      io.File(p.join(dir.path, 'index.html')).readAsStringSync(),
      contains('content="2026.10.29"'),
    );
  });

  test(
    'carries engine revision and local CanvasKit into the artifacts',
    () async {
      writeBuild();
      io.File(p.join(dir.path, 'flutter_bootstrap.js')).writeAsStringSync('''
_flutter.buildConfig = {"engineRevision":"0123456789abcdef","useLocalCanvasKit":true,"builds":[{"compileTarget":"dart2js","renderer":"canvaskit","mainJsPath":"main.dart.js"}]};
''');
      await generate(config());
      final sw = io.File(p.join(dir.path, 'sw.js')).readAsStringSync();
      final bootstrap = io.File(
        p.join(dir.path, 'bootstrap.js'),
      ).readAsStringSync();
      expect(sw, contains('"engineRevision":"0123456789abcdef"'));
      expect(bootstrap, contains('"engineRevision":"0123456789abcdef"'));
      expect(bootstrap, contains('"useLocalCanvasKit":true'));
    },
  );

  test('writes the artifacts under the configured names', () async {
    writeBuild();
    await generate(
      GeneratorConfig(
        inputDir: dir.path,
        version: 'v1',
        swOutput: 'service-worker.js',
        bootstrapOutput: 'boot.js',
      ),
    );
    expect(io.File(p.join(dir.path, 'service-worker.js')).existsSync(), isTrue);
    final bootstrap = io.File(p.join(dir.path, 'boot.js')).readAsStringSync();
    // The bootstrap registers the worker by the name it was written under.
    expect(bootstrap, contains('"swFilename":"service-worker.js"'));
    expect(io.File(p.join(dir.path, 'sw.js')).existsSync(), isFalse);
  });

  test('keeps source maps only with keepMaps', () async {
    writeBuild();
    final map = io.File(p.join(dir.path, 'main.dart.js.map'))
      ..writeAsStringSync('{}');
    await generate(
      GeneratorConfig(inputDir: dir.path, version: 'v1', keepMaps: true),
    );
    expect(map.existsSync(), isTrue);
    // Kept on disk, but never part of the manifest.
    final sw = io.File(p.join(dir.path, 'sw.js')).readAsStringSync();
    expect(sw, isNot(contains('main.dart.js.map')));
  });

  test('keeps flutter_bootstrap.js when the shell was never swapped', () async {
    writeBuild(
      indexHtml:
          '<html><body><script src="flutter_bootstrap.js" async></script>'
          ' </body></html>',
    );
    await generate(config());
    expect(
      io.File(p.join(dir.path, 'flutter_bootstrap.js')).existsSync(),
      isTrue,
    );
    expect(io.File(p.join(dir.path, 'flutter.js')).existsSync(), isFalse);
  });

  test(
    'keeps every skwasm variant and prunes CanvasKit for a skwasm build',
    () async {
      writeBuild();
      io.File(p.join(dir.path, 'flutter_bootstrap.js')).writeAsStringSync('''
_flutter.buildConfig = {"engineRevision":"abc123","builds":[{"compileTarget":"dart2wasm","renderer":"skwasm","mainWasmPath":"main.dart.wasm","jsSupportRuntimePath":"main.dart.mjs"}]};
''');
      const kept = [
        'canvaskit/skwasm.js',
        'canvaskit/skwasm.wasm',
        'canvaskit/skwasm_heavy.js',
        'canvaskit/skwasm_heavy.wasm',
        'canvaskit/wimp.js',
        'canvaskit/wimp.wasm',
      ];
      const pruned = [
        'canvaskit/canvaskit.js',
        'canvaskit/canvaskit.wasm',
        'canvaskit/chromium/canvaskit.js',
        'canvaskit/chromium/canvaskit.wasm',
      ];
      for (final path in [...kept, ...pruned]) {
        io.File(p.join(dir.path, path))
          ..createSync(recursive: true)
          ..writeAsStringSync('// $path');
      }

      await generate(config());

      for (final path in kept) {
        expect(
          io.File(p.join(dir.path, path)).existsSync(),
          isTrue,
          reason: path,
        );
      }
      for (final path in pruned) {
        expect(
          io.File(p.join(dir.path, path)).existsSync(),
          isFalse,
          reason: path,
        );
      }
      expect(
        io.Directory(p.join(dir.path, 'canvaskit/chromium')).existsSync(),
        isFalse,
      );
      // The variants are lazily cached, never pre-cached.
      final sw = io.File(p.join(dir.path, 'sw.js')).readAsStringSync();
      final entry = RegExp(
        r'"canvaskit/skwasm\.wasm":(\{[^}]*\})',
      ).firstMatch(sw);
      expect(entry, isNotNull);
      expect(
        (jsonDecode(entry!.group(1)!) as Map<String, dynamic>)['category'],
        'optional',
      );
    },
  );

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
