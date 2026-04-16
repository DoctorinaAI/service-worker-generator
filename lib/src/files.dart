import 'dart:io' as io;

import 'package:crypto/crypto.dart' as crypto;
import 'package:glob/glob.dart' as glob;
import 'package:path/path.dart' as p;

/// Convert a file system path to a URL path.
String pathToUrl(String path) => p.url.normalize(
  (!io.Platform.isWindows) ? path : path.replaceAll(r'\', '/'),
);

/// Get recursive map of files in a directory.
/// The keys are the relative paths of the files,
/// and the values are the [io.File] objects.
Map<String, io.File> filesInDirectory(
  io.Directory directory, {
  Set<String> include = const <String>{'**'},
  Set<String> exclude = const <String>{},
}) {
  if (!directory.existsSync()) return const {};
  final $include = include
      .map<glob.Glob>((e) => glob.Glob(e, context: p.url, recursive: true))
      .toList(growable: false);
  final $exclude = exclude
      .map<glob.Glob>((e) => glob.Glob(e, context: p.url, recursive: true))
      .toList(growable: false);
  final files = directory
      .listSync(recursive: true, followLinks: false)
      .whereType<io.File>();
  final dir = pathToUrl(directory.path);
  final result = <String, io.File>{};
  for (final file in files) {
    final path = p.url.relative(pathToUrl(file.path), from: dir);
    if (!$include.any((g) => g.matches(path))) continue;
    if ($exclude.any((g) => g.matches(path))) continue;
    result[path] = file;
  }
  return result;
}

/// Extract the md5 hash of a file.
Future<String> md5(io.File file) async {
  final bytes = await file.readAsBytes();
  final digest = crypto.md5.convert(bytes);
  return digest.toString();
}
