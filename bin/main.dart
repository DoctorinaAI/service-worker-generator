import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;

import 'package:args/args.dart';
import 'package:path/path.dart' as path;
import 'package:sw/sw.dart';

// TODO(plugfox): Add demo progress bar
// with current progress during the initialization.
// Mike Matiunin <plugfox@gmail.com>, 28 May 2025

// TODO(plugfox): Allow to add interceptors
// to the service worker with custom logic.
// Mike Matiunin <plugfox@gmail.com>, 28 May 2025

final $log = io.stdout.writeln; // Log to stdout
final $err = io.stderr.writeln; // Log to stderr

void main([List<String>? arguments]) => runZonedGuarded<void>(
  () async {
    // Get command line arguments
    // If no arguments are provided, use the default values
    final parser = buildArgumentsParser();
    final $arguments = parser.parse(arguments ?? []);
    if ($arguments['help'] == true) {
      io.stdout
        ..writeln(_help)
        ..writeln()
        ..writeln(parser.usage);
      io.exit(0);
    }

    final indexDirectory = io.Directory(
      path.normalize($arguments.option('input') ?? 'build/web'),
    );
    final outputFile = io.File(
      path.normalize(
        path.join(indexDirectory.path, $arguments.option('output') ?? '.'),
      ),
    );

    // Check if the input directory exists
    if (!indexDirectory.existsSync()) {
      $err('Error: Input directory does not exist: ${indexDirectory.path}');
      io.exit(1);
    } else if (!indexDirectory.listSync().whereType<io.File>().any(
      (f) => f.path.toLowerCase() != 'index.html',
    )) {
      $err(
        'Error: No index.html file found in the input directory: '
        '${indexDirectory.path}',
      );
      io.exit(1);
    }

    // Find all files in the input directory to include in the service worker
    $log('Retrieving files from: ${indexDirectory.path}');
    final files = filesInDirectory(
      indexDirectory,
      include:
          $arguments
              .option('glob')
              ?.split(',')
              .map((e) => e.trim())
              .where((e) => e.isNotEmpty)
              .toSet() ??
          const <String>{'**'},
      exclude:
          $arguments
              .option('no-glob')
              ?.split(',')
              .map((e) => e.trim())
              .where((e) => e.isNotEmpty)
              .toSet() ??
          const <String>{},
    );

    // Create a resource map with the relative paths and their MD5 hashes
    $log('Generating resource map for ${files.length} files...');
    final resources = <String, Object?>{
      for (final MapEntry(key: String url, value: io.File file)
          in files.entries)
        url: <String, Object?>{
          'name': path.basename(url),
          'size': await file.length(),
          'hash': await md5(file),
        },
    };

    // Cache prefix for the service worker
    // This can be used to differentiate between different service workers
    final cachePrefix =
        $arguments
            .option('prefix')
            ?.replaceAll(RegExp('[^A-Za-z0-9_-]'), '-')
            .replaceAll(RegExp('-{2,}'), '-') ??
        'app-cache';
    final cacheVersion =
        $arguments
            .option('version')
            ?.replaceAll(RegExp('[^A-Za-z0-9_-]'), '-')
            .replaceAll(RegExp('-{2,}'), '-') ??
        DateTime.now().millisecondsSinceEpoch.toString();

    var serviceWorkerText = buildServiceWorker(
      cachePrefix: cachePrefix,
      cacheVersion: cacheVersion,
      resources: <String, Object?>{
        if (resources['index.html'] case Object obj) '/': obj,
        ...resources,
      },
    );
    if (!$arguments.flag('comments'))
      serviceWorkerText = removeComments(serviceWorkerText);

    // Write the service worker file
    $log('Writing service worker file to: ${outputFile.path}');
    outputFile.parent.createSync(recursive: true);
    await io.File(outputFile.path).writeAsString(
      serviceWorkerText,
      mode: io.FileMode.writeOnly,
      encoding: utf8,
      flush: true,
    );
  },
  (e, s) {
    $err('An error occurred: $e');
    io.exit(1);
  },
);

/// Parse arguments
ArgParser buildArgumentsParser() => ArgParser()
  ..addFlag(
    'help',
    abbr: 'h',
    aliases: const <String>['readme', 'usage'],
    negatable: false,
    defaultsTo: false,
    help: 'Print this usage information',
  )
  ..addOption(
    'input',
    abbr: 'i',
    aliases: const <String>[
      'dir',
      'directory',
      'project',
      'build',
      'web',
      'index',
    ],
    mandatory: false,
    defaultsTo: 'build/web',
    valueHelp: 'path/to/build/web',
    help:
        'Path to output build/web directory where the index.html file is located',
  )
  ..addOption(
    'output',
    abbr: 'o',
    aliases: const <String>[
      'out',
      'file',
      'out-file',
      'output-file',
      'worker',
      'location',
      'generated',
    ],
    mandatory: false,
    defaultsTo: 'sw.js',
    valueHelp: 'path/to/output/service_worker.js',
    help: 'Output path for generated file relative to the input directory',
  )
  ..addOption(
    'prefix',
    abbr: 'p',
    aliases: const <String>['prefixes', 'cache-prefix'],
    mandatory: false,
    defaultsTo: 'app-cache',
    valueHelp: 'app-cache',
    help:
        'Prefix for the service worker cache name. '
        'This can be used to differentiate between different service workers '
        'or versions of the same service worker.',
  )
  ..addOption(
    'version',
    abbr: 'v',
    aliases: const <String>['cache', 'cache-version'],
    mandatory: false,
    valueHelp: '1.0.0, 20231001, v1.2.3',
    help:
        'Version of the service worker cache. '
        'This can be used to bust the cache when deploying updates.',
  )
  ..addOption(
    'glob',
    abbr: 'g',
    aliases: const <String>['pattern', 'files', 'assets', 'include'],
    mandatory: false,
    defaultsTo: '**',
    valueHelp: 'assets/**/*.json, assets/**/*.png, **/*.js',
    help: 'Glob pattern to include files in the service worker',
  )
  ..addOption(
    'no-glob',
    abbr: 'e',
    aliases: const <String>['no-pattern', 'no-files', 'no-assets', 'exclude'],
    mandatory: false,
    defaultsTo: '',
    valueHelp: 'assets/NOTICES, sw.js, **/node_modules/**',
    help: 'Glob pattern to exclude files from the service worker',
  )
  ..addFlag(
    'comments',
    abbr: 'c',
    aliases: const <String>['comment', 'comments', 'with-comments'],
    negatable: true,
    defaultsTo: false,
    help:
        'Include comments in the generated service worker file. '
        'This is useful for debugging and understanding the generated code.',
  );

/// Help message for the command line arguments
const String _help = '''
Service Worker Generator

A command line tool to generate service worker files for Dart and Flutter web applications.
''';
