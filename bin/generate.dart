import 'dart:async';
import 'dart:io' as io;

import 'package:sw/src/config.dart';
import 'package:sw/src/generator.dart';

/// Exit status for a command-line usage error (`EX_USAGE`).
const int _exitUsage = 64;

/// Service Worker Generator CLI entry point.
///
/// A mistyped option or a broken input directory is the user's to fix, so
/// it prints the message alone. Anything else is a bug in the generator,
/// and keeps its stack trace for the report.
Future<void> main(List<String> args) async {
  await runZonedGuarded(
    () async {
      final GeneratorConfig config;
      try {
        config = GeneratorConfig.parse(args);
      } on FormatException catch (e) {
        // ArgParserException is a FormatException: an unknown option, a
        // missing value or a value outside `allowed`.
        io.stderr
          ..writeln('Error: ${e.message}')
          ..writeln('Run "dart run sw:generate --help" for the options.');
        io.exitCode = _exitUsage;
        return;
      }

      try {
        await generate(config);
        // generate() reports a broken input (a missing directory or file,
        // an unreadable buildConfig) as a StateError by design.
        // ignore: avoid_catching_errors
      } on StateError catch (e) {
        io.stderr.writeln('Error: ${e.message}');
        io.exitCode = 1;
      } on io.FileSystemException catch (e) {
        io.stderr.writeln('Error: ${_describe(e)}');
        io.exitCode = 1;
      }
    },
    (error, stack) {
      io.stderr.writeln('Error: $error');
      io.stderr.writeln(stack);
      io.exitCode = 1;
    },
  );
}

/// "message: path (OS error)", without the exception's type name.
String _describe(io.FileSystemException e) {
  final buffer = StringBuffer(e.message);
  if (e.path case final path? when path.isNotEmpty) buffer.write(': $path');
  if (e.osError case final osError?) buffer.write(' ($osError)');
  return buffer.toString();
}
