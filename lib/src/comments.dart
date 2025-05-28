/// Utility function for removing single-line (//...) and multi-line (/*...*/) comments,
/// and eliminating empty or whitespace-only lines.
String removeComments(String input) {
  final commentRegex = RegExp(
    r'//.*?$|/\*[\s\S]*?\*/',
    multiLine: true,
    dotAll: true,
  );

  // Remove all comments
  final withoutComments = input.replaceAll(commentRegex, '');

  // Trim lines and remove empty ones
  return withoutComments
      .split('\n')
      .map((line) => line.trim())
      .where((line) => line.isNotEmpty)
      .join('\n');
}
