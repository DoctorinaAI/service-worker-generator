import 'dart:io' as io;

import 'package:path/path.dart' as p;
import 'package:test/test.dart';

/// Runs `bin/generate.dart` in a child VM.
///
/// Environment variables and `io.exit` cannot be exercised in-process, so
/// the env half of the CLI > YAML > env precedence and the exit statuses
/// are checked here. The child sees none of the caller's `SW_*` variables.
void main() {
  late io.Directory dir;

  setUp(() {
    dir = io.Directory.systemTemp.createTempSync('sw_cli_test');
    io.File(p.join(dir.path, 'flutter_bootstrap.js')).writeAsStringSync('''
_flutter.buildConfig = {"engineRevision":"abc123","builds":[{"compileTarget":"dart2js","renderer":"canvaskit","mainJsPath":"main.dart.js"}]};
''');
    io.File(p.join(dir.path, 'flutter.js')).writeAsStringSync('// loader');
    io.File(p.join(dir.path, 'index.html')).writeAsStringSync(
      '<html><body><script src="bootstrap.js" defer></script></body></html>',
    );
    io.File(p.join(dir.path, 'main.dart.js')).writeAsStringSync('main');
    io.File(p.join(dir.path, 'main.dart.js.map')).writeAsStringSync('map');
  });

  tearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });

  Future<io.ProcessResult> run(
    List<String> args, {
    Map<String, String> env = const {},
  }) {
    final environment = {
      for (final e in io.Platform.environment.entries)
        if (!e.key.startsWith('SW_')) e.key: e.value,
      ...env,
    };
    return io.Process.run(
      io.Platform.resolvedExecutable,
      [
        'bin/generate.dart',
        // Never pick up an sw.yaml from the working directory.
        '--config=${p.join(dir.path, 'absent.yaml')}',
        ...args,
      ],
      environment: environment,
      includeParentEnvironment: false,
    );
  }

  bool exists(String name) => io.File(p.join(dir.path, name)).existsSync();

  test('--help lists the flag environment variables and exits 0', () async {
    final result = await run(const ['--help']);
    expect(result.exitCode, 0);
    expect(result.stdout, contains('--[no-]keep-maps'));
    expect(
      result.stdout,
      allOf(
        contains('SW_KEEP_MAPS'),
        contains('SW_NO_CLEANUP'),
        contains('SW_COMMENTS'),
      ),
    );
  });

  test('an invalid boolean in the environment exits 64', () async {
    final result = await run(
      ['--input=${dir.path}'],
      env: const {'SW_KEEP_MAPS': 'maybe'},
    );
    expect(result.exitCode, 64);
    expect(
      result.stderr,
      contains('SW_KEEP_MAPS="maybe" (environment) is not a valid boolean'),
    );
    // Rejected before anything was generated.
    expect(exists('sw.js'), isFalse);
  });

  test('an invalid integer exits 64', () async {
    final result = await run(['--input=${dir.path}', '--max-progress=lots']);
    expect(result.exitCode, 64);
    expect(result.stderr, contains('--max-progress="lots"'));
  });

  test(
    'SW_NO_CLEANUP and SW_KEEP_MAPS apply when the CLI omits them',
    () async {
      final result = await run(
        ['--input=${dir.path}'],
        env: const {'SW_NO_CLEANUP': 'true'},
      );
      expect(result.exitCode, 0, reason: '${result.stderr}');
      expect(exists('sw.js'), isTrue);
      expect(exists('flutter_bootstrap.js'), isTrue);
      expect(exists('flutter.js'), isTrue);

      final second = await run(
        ['--input=${dir.path}'],
        env: const {'SW_KEEP_MAPS': 'yes'},
      );
      expect(second.exitCode, 0, reason: '${second.stderr}');
      expect(exists('flutter_bootstrap.js'), isFalse);
      expect(exists('main.dart.js.map'), isTrue);
    },
  );

  test('an explicit CLI flag beats the environment', () async {
    final result = await run(
      ['--input=${dir.path}', '--no-no-cleanup', '--no-keep-maps'],
      env: const {'SW_NO_CLEANUP': 'true', 'SW_KEEP_MAPS': 'true'},
    );
    expect(result.exitCode, 0, reason: '${result.stderr}');
    expect(exists('flutter_bootstrap.js'), isFalse);
    expect(exists('main.dart.js.map'), isFalse);
  });

  test('YAML beats the environment', () async {
    final yaml = io.File(p.join(dir.path, 'sw.yaml'))
      ..writeAsStringSync('no-cleanup: false\n');
    final result = await run(
      ['--input=${dir.path}', '--config=${yaml.path}'],
      env: const {'SW_NO_CLEANUP': 'true'},
    );
    expect(result.exitCode, 0, reason: '${result.stderr}');
    expect(exists('flutter_bootstrap.js'), isFalse);
  });

  test('a missing build directory exits 1', () async {
    final result = await run(['--input=${p.join(dir.path, 'nope')}']);
    expect(result.exitCode, 1);
    expect(result.stderr, contains('Build directory not found'));
  });

  test('an unknown option exits 64 with a hint and no stack trace', () async {
    final result = await run(['--inptu=${dir.path}']);
    expect(result.exitCode, 64);
    expect(result.stderr, contains('Error: Could not find an option named'));
    expect(result.stderr, contains('--help'));
    expect(result.stderr, isNot(contains('#0 ')));
    expect(exists('sw.js'), isFalse);
  });

  test('a missing option value exits 64', () async {
    final result = await run(['--input']);
    expect(result.exitCode, 64);
    expect(result.stderr, contains('Error: '));
    expect(result.stderr, isNot(contains('#0 ')));
  });

  test('a missing build directory prints no stack trace', () async {
    final result = await run(['--input=${p.join(dir.path, 'nope')}']);
    expect(result.exitCode, 1);
    expect(result.stderr, contains('Error: Build directory not found'));
    expect(result.stderr, isNot(contains('#0 ')));
    expect(result.stderr, isNot(contains('Bad state')));
  });

  test('a file system error exits 1 without a stack trace', () async {
    // A directory already holds the worker's name, so it cannot be written.
    io.Directory(p.join(dir.path, 'taken.js')).createSync();
    final result = await run(['--input=${dir.path}', '--output=taken.js']);
    expect(result.exitCode, 1);
    expect(result.stderr, contains('Error: '));
    expect(result.stderr, contains('taken.js'));
    expect(result.stderr, isNot(contains('#0 ')));
  });

  test('an absent implicit sw.yaml is silent', () async {
    final result = await io.Process.run(
      io.Platform.resolvedExecutable,
      [p.absolute('bin/generate.dart'), '--input=${dir.path}'],
      workingDirectory: dir.path,
      environment: {
        for (final e in io.Platform.environment.entries)
          if (!e.key.startsWith('SW_')) e.key: e.value,
      },
      includeParentEnvironment: false,
    );
    expect(result.exitCode, 0, reason: '${result.stderr}');
    expect(result.stderr, isNot(contains('config file not found')));
  });

  group('usage errors exit 64 without a stack trace', () {
    Future<void> expectUsageError(
      List<String> args,
      List<String> messages, {
      Map<String, String> env = const {},
    }) async {
      final index = io.File(p.join(dir.path, 'index.html')).readAsBytesSync();
      final result = await run(['--input=${dir.path}', ...args], env: env);
      expect(result.exitCode, 64, reason: '${result.stderr}');
      for (final message in messages) {
        expect(result.stderr, contains(message));
      }
      expect(result.stderr, isNot(contains('#0 ')));
      // Rejected before anything in the build was touched.
      expect(exists('sw.js'), isFalse);
      expect(exists('bootstrap.js'), isFalse);
      expect(io.File(p.join(dir.path, 'index.html')).readAsBytesSync(), index);
    }

    test('an output name in a subdirectory', () async {
      await expectUsageError(
        ['--output=js/sw.js'],
        ['--output="js/sw.js"', 'path separator'],
      );
      expect(io.Directory(p.join(dir.path, 'js')).existsSync(), isFalse);
    });

    test('a bootstrap name outside the build directory', () async {
      await expectUsageError(
        ['--bootstrap-output=..'],
        ['--bootstrap-output=".."'],
      );
    });

    test('an output name from the environment', () async {
      await expectUsageError(
        const [],
        ['SW_OUTPUT="/tmp/sw.js" (environment)'],
        env: const {'SW_OUTPUT': '/tmp/sw.js'},
      );
    });

    test('an invalid glob, naming the option', () async {
      await expectUsageError(
        ['--core=['],
        ['--core contains "["', 'not a valid glob'],
      );
    });

    test('an invalid glob from the environment', () async {
      await expectUsageError(
        const [],
        ['SW_IGNORE (environment) contains "{a"'],
        env: const {'SW_IGNORE': 'ok/**; {a'},
      );
    });

    test('an invalid integer names the environment variable', () async {
      await expectUsageError(
        const [],
        ['SW_MIN_PROGRESS="ten" (environment) is not a valid integer'],
        env: const {'SW_MIN_PROGRESS': 'ten'},
      );
    });

    test('an invalid integer names the YAML key and file', () async {
      final yaml = io.File(p.join(dir.path, 'sw.yaml'))
        ..writeAsStringSync('max-progress: lots\n');
      await expectUsageError(
        ['--config=${yaml.path}'],
        ['max-progress="lots" (in ${yaml.path}) is not a valid integer'],
      );
    });

    test('a YAML mapping where a glob list belongs', () async {
      final yaml = io.File(p.join(dir.path, 'sw.yaml'))
        ..writeAsStringSync('glob:\n  a: b\n');
      await expectUsageError(
        ['--config=${yaml.path}'],
        ['"glob" in ${yaml.path} is a mapping'],
      );
    });

    test('a version that names the manifest cache', () async {
      await expectUsageError(['--version=manifest'], ['"{prefix}-manifest"']);
    });

    test('a version that looks like another app\'s manifest cache', () async {
      await expectUsageError(
        ['--version=2.0-manifest'],
        ['--version="2.0-manifest"', 'ends with "-manifest"'],
      );
    });

    test('a version that looks like a temporary cache', () async {
      await expectUsageError(
        const [],
        ['SW_VERSION="temp-1" (environment)', 'starts with "temp-"'],
        env: const {'SW_VERSION': 'temp-1'},
      );
    });
  });
}
