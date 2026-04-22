import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sw_example/src/update/update_check_api.dart';
import 'package:sw_example/src/update/update_check_state.dart';

final class UpdateCheckController extends ChangeNotifier {
  UpdateCheckController({
    required UpdateCheckApi updateCheckApi,
    required String version,
  }) : _updateCheckApi = updateCheckApi,
       _state = IdleUpdateCheckState(version) {
    _updateSubscription = _updateCheckApi.onUpdateAvailable.listen((_) {
      _isCurrentPendingUpdateDismissed = false;
      checkForUpdates();
    });
  }

  final UpdateCheckApi _updateCheckApi;

  late final StreamSubscription<void> _updateSubscription;
  UpdateCheckState _state;
  bool _isCurrentPendingUpdateDismissed = false;
  bool _isDisposed = false;

  UpdateCheckState get state => _state;

  void ignoreUpdate() {
    if (_isDisposed) return;
    _isCurrentPendingUpdateDismissed =
        _updateCheckApi.hasPendingUpdate || _state is UpdateAvailableState;
    _setState(IdleUpdateCheckState(_state.version));
  }

  Future<void> update() async {
    if (_isDisposed ||
        _state is ApplyingUpdateState ||
        _state is IdleUpdateCheckState) {
      return;
    }
    final version = _state.version;
    _setState(ApplyingUpdateState(version));
    try {
      await _updateCheckApi.updateApplication();
    } on Object catch (error, stackTrace) {
      debugPrint('UpdateCheckController.update failed: $error\n$stackTrace');
      _setState(UpdateAvailableState(version));
    }
  }

  void checkForUpdates() {
    if (_isDisposed) return;
    if (!_updateCheckApi.hasPendingUpdate) return;
    if (_isCurrentPendingUpdateDismissed) return;
    if (_state is UpdateAvailableState || _state is ApplyingUpdateState) return;
    _setState(UpdateAvailableState(_state.version));
  }

  @override
  void dispose() {
    if (_isDisposed) return;
    _isDisposed = true;
    _updateSubscription.cancel();
    _updateCheckApi.dispose();
    super.dispose();
  }

  void _setState(UpdateCheckState state) {
    if (_state.runtimeType == state.runtimeType &&
        _state.version == state.version) {
      return;
    }
    _state = state;
    notifyListeners();
  }
}
