import 'dart:async';

import 'package:sw_example/src/update/update_check_api.dart';

UpdateCheckApi createUpdateCheckApi() => _NoOpUpdateCheckApi();

final class _NoOpUpdateCheckApi implements UpdateCheckApi {
  @override
  bool get hasPendingUpdate => false;

  @override
  Stream<void> get onUpdateAvailable => const Stream<void>.empty();

  @override
  Future<void> updateApplication() async {}

  @override
  void dispose() {}
}
