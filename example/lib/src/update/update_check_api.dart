import 'dart:async';

abstract class UpdateCheckApi {
  bool get hasPendingUpdate;

  Stream<void> get onUpdateAvailable;

  Future<void> updateApplication();

  void dispose();
}
