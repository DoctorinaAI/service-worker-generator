import 'dart:io' as io;

import 'package:crypto/crypto.dart' as crypto;
import 'package:glob/glob.dart' as glob;
import 'package:path/path.dart' as p;

import 'diagnostics.dart';

/// Convert a file system path to a URL path.
String pathToUrl(String path) => p.url.normalize(
  (!io.Platform.isWindows) ? path : path.replaceAll(r'\', '/'),
);

/// Get recursive map of files in a directory.
/// The keys are the relative paths of the files,
/// and the values are the [io.File] objects.
///
/// Symbolic links are not followed, so a link cannot pull files from
/// outside [directory] into the result. Each skipped link that the globs
/// would otherwise have selected is reported on stderr.
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
  final entities = directory.listSync(recursive: true, followLinks: false);
  final dir = pathToUrl(directory.path);
  final result = <String, io.File>{};
  final skippedLinks = <String>[];
  for (final entity in entities) {
    if (entity is! io.File && entity is! io.Link) continue;
    final path = p.url.relative(pathToUrl(entity.path), from: dir);
    if (!$include.any((g) => g.matches(path))) continue;
    if ($exclude.any((g) => g.matches(path))) continue;
    if (entity is io.File) {
      result[path] = entity;
    } else {
      skippedLinks.add(path);
    }
  }
  if (skippedLinks.isNotEmpty) {
    skippedLinks.sort();
    io.stderr.writeln(
      'Warning: skipped ${skippedLinks.length} symlink(s); links are not '
      'followed, so they are not in the manifest. Copy the target into the '
      'build instead:\n${formatPathList(skippedLinks)}',
    );
  }
  return result;
}

/// Extract the md5 hash of a file.
///
/// The file is streamed in chunks, so hashing a large asset does not load
/// it into memory at once. The digest is the same as hashing the bytes.
Future<String> md5(io.File file) async {
  final digest = await crypto.md5.bind(file.openRead()).single;
  return digest.toString();
}
