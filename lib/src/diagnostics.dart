/// Helpers for the generator's log output. Not exported from `sw.dart`.
library;

/// Format [paths] as indented lines, at most [limit] of them, followed by
/// "... and N more" when the list was cut.
String formatPathList(List<String> paths, {int limit = 10}) {
  final shown = paths.take(limit).map((e) => '    $e');
  final rest = paths.length - limit;
  return [...shown, if (rest > 0) '    ... and $rest more'].join('\n');
}
