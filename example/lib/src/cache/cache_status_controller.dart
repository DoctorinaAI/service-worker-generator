import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sw_example/src/cache/cache_snapshot.dart';

/// Keeps a [CacheSnapshot] current by reading it on an interval.
///
/// Files land in the cache in the worker, and the page hears nothing about
/// it, so there is no event to listen for.
class CacheStatusController extends ValueNotifier<CacheSnapshot> {
  /// Creates a controller. Call [start] to begin reading.
  CacheStatusController({
    required this.read,
    this.interval = const Duration(seconds: 1),
  }) : super(const CacheSnapshot());

  /// Reads the current state.
  final Future<CacheSnapshot> Function() read;

  /// Time between reads.
  final Duration interval;

  Timer? _timer;
  bool _reading = false;

  /// Read now, then on every [interval].
  void start() {
    _timer ??= Timer.periodic(interval, (_) => refresh());
    refresh();
  }

  /// Read now. Skipped while a read is still running.
  Future<void> refresh() async {
    if (_reading) return;
    _reading = true;
    try {
      final next = await read();
      if (_timer != null) value = next;
    } finally {
      _reading = false;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }
}
