import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sw_example/src/update/update_check_controller.dart';
import 'package:sw_example/src/update/update_check_state.dart';

import '../../test_support/fake_update_check_api.dart';

void main() {
  group('UpdateCheckController', () {
    test('moves from idle to updateAvailable to applyingUpdate', () async {
      final api = FakeUpdateCheckApi();
      final controller = UpdateCheckController(
        updateCheckApi: api,
        version: '1.0.0',
      );
      addTearDown(controller.dispose);

      expect(controller.state, isA<IdleUpdateCheckState>());

      api.emitPendingUpdate();
      await Future<void>.delayed(Duration.zero);

      expect(controller.state, isA<UpdateAvailableState>());

      final completer = Completer<void>();
      api.completeNextUpdateWith(completer);
      final updateFuture = controller.update();

      expect(controller.state, isA<ApplyingUpdateState>());

      completer.complete();
      await updateFuture;
      expect(api.updateCalls, 1);
    });

    test('restores updateAvailable when applying the update fails', () async {
      final api = FakeUpdateCheckApi();
      final controller = UpdateCheckController(
        updateCheckApi: api,
        version: '1.0.0',
      );
      addTearDown(controller.dispose);

      api.emitPendingUpdate();
      await Future<void>.delayed(Duration.zero);
      api.failNextUpdateWith(StateError('boom'));

      await controller.update();

      expect(controller.state, isA<UpdateAvailableState>());
      expect(api.updateCalls, 1);
    });
  });
}
