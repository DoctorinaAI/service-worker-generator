import 'dart:async';
import 'dart:io' as io;

/// What [captureOutput] saw on each stream.
class CapturedOutput<T> {
  /// Create a captured output.
  const CapturedOutput(this.result, this.stdout, this.stderr);

  /// The value the body returned.
  final T result;

  /// Everything the body wrote to `stdout`.
  final String stdout;

  /// Everything the body wrote to `stderr`.
  final String stderr;
}

/// Run [body] with `stdout` and `stderr` redirected into buffers.
///
/// The generator reports through `io.stdout` / `io.stderr`, which resolve
/// through [io.IOOverrides], so warnings can be asserted in-process.
Future<CapturedOutput<T>> captureOutput<T>(FutureOr<T> Function() body) async {
  // In-memory buffers: there is nothing to close.
  // ignore: close_sinks
  final out = _BufferStdout();
  // ignore: close_sinks
  final err = _BufferStdout();
  final result = await io.IOOverrides.runZoned(
    () async => body(),
    stdout: () => out,
    stderr: () => err,
  );
  return CapturedOutput(result, out.text, err.text);
}

class _BufferStdout implements io.Stdout {
  final StringBuffer _buffer = StringBuffer();

  String get text => _buffer.toString();

  @override
  void write(Object? object) => _buffer.write(object);

  @override
  void writeln([Object? object = '']) => _buffer.writeln(object);

  @override
  void writeAll(Iterable<dynamic> objects, [String separator = '']) =>
      _buffer.writeAll(objects, separator);

  @override
  void writeCharCode(int charCode) => _buffer.writeCharCode(charCode);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
