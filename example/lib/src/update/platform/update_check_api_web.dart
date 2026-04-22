// ignore_for_file: avoid_web_libraries_in_flutter

import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/foundation.dart';
import 'package:sw_example/src/update/update_check_api.dart';
import 'package:web/web.dart' as web;

const Duration _applyUpdateTimeout = Duration(seconds: 10);
const Duration _registrationUpdateInterval = Duration(minutes: 15);
const Duration _visibilityDebounce = Duration(seconds: 30);

extension type const _BootstrapApi._(JSObject _) implements JSObject {
  external JSFunction onUpdateAvailable(JSFunction handler);

  external JSPromise<JSBoolean> applyUpdate(JSBoolean reload);
}

@JS('Bootstrap')
external _BootstrapApi? get _bootstrap;

UpdateCheckApi createUpdateCheckApi() => UpdateCheckApiImpl();

final class UpdateCheckApiImpl implements UpdateCheckApi {
  UpdateCheckApiImpl() {
    _subscribeToBootstrapUpdate();
    _startRegistrationUpdateTimer();
    _startVisibilityListener();
  }

  bool _updatePending = false;
  final StreamController<void> _updateController =
      StreamController<void>.broadcast();
  Timer? _registrationUpdateTimer;
  JSFunction? _visibilityListener;
  DateTime _lastUpdateCallAt = DateTime.fromMillisecondsSinceEpoch(0);
  bool _disposed = false;

  @override
  bool get hasPendingUpdate => _updatePending;

  @override
  Stream<void> get onUpdateAvailable => _updateController.stream;

  @override
  Future<void> updateApplication() async {
    final bootstrap = _bootstrap;
    if (bootstrap == null) {
      debugPrint(
        'UpdateCheckApiImpl.updateApplication | bootstrap missing, forcing reload',
      );
      web.window.location.reload();
      return;
    }

    try {
      final applied =
          (await bootstrap
                  .applyUpdate(true.toJS)
                  .toDart
                  .timeout(_applyUpdateTimeout))
              .toDart;
      if (applied) {
        debugPrint(
          'UpdateCheckApiImpl.updateApplication | activated waiting worker',
        );
        return;
      }
      if (_updatePending) {
        debugPrint(
          'UpdateCheckApiImpl.updateApplication | applyUpdate returned false while a pending update exists, forcing reload',
        );
        web.window.location.reload();
        return;
      }
      debugPrint(
        'UpdateCheckApiImpl.updateApplication | no pending update to apply',
      );
      throw StateError('No pending update available to apply');
    } on TimeoutException {
      debugPrint(
        'UpdateCheckApiImpl.updateApplication | applyUpdate timed out, forcing reload',
      );
      web.window.location.reload();
    } on StateError {
      rethrow;
    } on Object catch (error, stackTrace) {
      debugPrint(
        'UpdateCheckApiImpl.updateApplication | applyUpdate failed: $error',
      );
      debugPrint('$stackTrace');
      web.window.location.reload();
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _registrationUpdateTimer?.cancel();
    _registrationUpdateTimer = null;
    final listener = _visibilityListener;
    if (listener != null) {
      web.document.removeEventListener('visibilitychange', listener);
      _visibilityListener = null;
    }
    unawaited(_updateController.close());
  }

  void _subscribeToBootstrapUpdate() {
    final bootstrap = _bootstrap;
    if (bootstrap == null) return;
    try {
      bootstrap.onUpdateAvailable(
        (() => _markUpdatePending('Bootstrap.onUpdateAvailable')).toJS,
      );
    } on Object catch (error, stackTrace) {
      debugPrint(
        'UpdateCheckApiImpl._subscribeToBootstrapUpdate failed: $error',
      );
      debugPrint('$stackTrace');
      return;
    }

    unawaited(_probeWaitingRegistration());
  }

  Future<void> _probeWaitingRegistration() async {
    if (_disposed) return;
    final serviceWorker = web.window.navigator.serviceWorker;
    try {
      final registration = await serviceWorker.getRegistration().toDart;
      if (registration != null &&
          registration.waiting != null &&
          serviceWorker.controller != null) {
        _markUpdatePending('registration probe');
      }
    } on Object catch (error, stackTrace) {
      debugPrint('UpdateCheckApiImpl._probeWaitingRegistration failed: $error');
      debugPrint('$stackTrace');
    }
  }

  void _markUpdatePending(String source) {
    if (_disposed) return;
    debugPrint(
      'UpdateCheckApiImpl pending update detected via $source | origin: ${web.window.location.origin}',
    );
    _updatePending = true;
    if (!_updateController.isClosed) {
      _updateController.add(null);
    }
  }

  void _startRegistrationUpdateTimer() {
    _registrationUpdateTimer = Timer.periodic(
      _registrationUpdateInterval,
      (_) => unawaited(_runRegistrationUpdate()),
    );
  }

  void _startVisibilityListener() {
    void onVisibilityChange(web.Event _) {
      if (_disposed) return;
      if (web.document.visibilityState != 'visible') return;
      final now = DateTime.now();
      if (now.difference(_lastUpdateCallAt) < _visibilityDebounce) return;
      unawaited(_runRegistrationUpdate());
    }

    final listener = onVisibilityChange.toJS;
    _visibilityListener = listener;
    web.document.addEventListener('visibilitychange', listener);
  }

  Future<void> _runRegistrationUpdate() async {
    if (_disposed) return;
    _lastUpdateCallAt = DateTime.now();
    final serviceWorker = web.window.navigator.serviceWorker;
    try {
      final registration = await serviceWorker.getRegistration().toDart;
      if (registration == null) return;
      await registration.update().toDart;
    } on Object catch (error, stackTrace) {
      debugPrint('UpdateCheckApiImpl._runRegistrationUpdate failed: $error');
      debugPrint('$stackTrace');
    }
  }
}
