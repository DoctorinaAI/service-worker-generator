import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;

import 'package:args/args.dart';
import 'package:path/path.dart' as path;

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
    final outputPath = io.File(
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

    outputPath.parent.createSync(recursive: true);
    final writer = io.File(
      outputPath.path,
    ).openWrite(mode: io.FileMode.write, encoding: utf8);
    try {} on Object {
      $err('Error: Failed to open output file: ${outputPath.path}');
      io.exit(1);
    } finally {
      // Ensure the writer is closed properly
      await writer.flush();
      await writer.close();
    }
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
    aliases: ['readme', 'usage'],
    negatable: false,
    defaultsTo: false,
    help: 'Print this usage information',
  )
  ..addOption(
    'input',
    abbr: 'i',
    aliases: ['dir', 'directory', 'project', 'build', 'web', 'index'],
    mandatory: false,
    defaultsTo: 'build/web',
    valueHelp: 'path/to/build/web',
    help:
        'Path to output build/web directory where the index.html file is located',
  )
  ..addOption(
    'output',
    abbr: 'o',
    aliases: [
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
  );

/// Help message for the command line arguments
const String _help = '''
Service Worker Generator

A command line tool to generate service worker files for Dart and Flutter web applications.
''';
