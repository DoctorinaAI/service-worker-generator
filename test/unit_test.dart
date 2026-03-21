import 'dart:io';

import 'package:test/test.dart';

void main() => group('generate', () {
      test('requires index.html in input directory', () async {
        final inputDirectory =
            await Directory.systemTemp.createTemp('sw_test_');
        addTearDown(() => inputDirectory.delete(recursive: true));

        final result = await Process.run(
          Platform.resolvedExecutable,
          <String>[
            'run',
            'bin/generate.dart',
            '--input=${inputDirectory.path}',
          ],
          workingDirectory: Directory.current.path,
        );

        expect(result.exitCode, equals(1));
        expect(result.stderr, contains('No index.html file found'));
      });
    });
