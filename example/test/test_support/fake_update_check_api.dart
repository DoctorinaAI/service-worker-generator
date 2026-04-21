import 'dart:async';

import 'package:sw_example/src/update/update_check_api.dart';

final class FakeUpdateCheckApi implements UpdateCheckApi {
  final StreamController<void> _updateController =
      StreamController<void>.broadcast();

  bool _hasPendingUpdate = false;
  Completer<void>? _updateCompleter;
  Object? _updateError;
  int updateCalls = 0;

  @override
  bool get hasPendingUpdate => _hasPendingUpdate;

  @override
  Stream<void> get onUpdateAvailable => _updateController.stream;

  void emitPendingUpdate() {
    _hasPendingUpdate = true;
    _updateController.add(null);
  }

  void clearPendingUpdate() {
    _hasPendingUpdate = false;
  }

  void completeNextUpdateWith(Completer<void> completer) {
    _updateCompleter = completer;
    _updateError = null;
  }

  void failNextUpdateWith(Object error) {
    _updateError = error;
    _updateCompleter = null;
  }

  @override
  Future<void> updateApplication() async {
    updateCalls++;
    if (_updateError != null) {
      throw _updateError!;
    }
    final completer = _updateCompleter;
    if (completer != null) {
      await completer.future;
    }
  }

  @override
  void dispose() {
    _updateController.close();
  }
}
