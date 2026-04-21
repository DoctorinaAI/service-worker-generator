import 'dart:async';
import 'dart:io' as io;

import 'package:sw/src/config.dart';
import 'package:sw/src/generator.dart';

/// Service Worker Generator CLI entry point.
Future<void> main(List<String> args) async {
  await runZonedGuarded(
    () async {
      final config = GeneratorConfig.parse(args);
      await generate(config);
    },
    (error, stack) {
      io.stderr.writeln('Error: $error');
      io.stderr.writeln(stack);
      io.exitCode = 1;
    },
  );
}
