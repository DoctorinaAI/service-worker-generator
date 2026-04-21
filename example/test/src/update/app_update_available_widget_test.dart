import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sw_example/src/update/app_update_available_widget.dart';
import 'package:sw_example/src/update/update_check_controller.dart';
import 'package:sw_example/src/update/update_check_state.dart';

import '../../test_support/fake_update_check_api.dart';

void main() {
  group('AppUpdateAvailableWidget', () {
    testWidgets('shows the banner and switches to Updating while applying', (
      tester,
    ) async {
      final api = FakeUpdateCheckApi();
      final controller = UpdateCheckController(
        updateCheckApi: api,
        version: '1.0.0',
      );
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: controller,
              builder: (context, _) {
                final state = controller.state;
                return state is IdleUpdateCheckState
                    ? const SizedBox.shrink()
                    : AppUpdateAvailableWidget(
                        updateCheckController: controller,
                      );
              },
            ),
          ),
        ),
      );

      api.emitPendingUpdate();
      await tester.pump();

      expect(find.textContaining('A new version (v1.0.0)'), findsOneWidget);
      expect(find.text('Update Now'), findsOneWidget);

      final completer = Completer<void>();
      api.completeNextUpdateWith(completer);

      await tester.tap(find.text('Update Now'));
      await tester.pump();

      expect(find.text('Updating...'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );

      completer.complete();
      await tester.pump();
    });

    testWidgets('Later dismisses the current update banner', (tester) async {
      final api = FakeUpdateCheckApi();
      final controller = UpdateCheckController(
        updateCheckApi: api,
        version: '1.0.0',
      );
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: controller,
              builder: (context, _) {
                final state = controller.state;
                return state is IdleUpdateCheckState
                    ? const SizedBox.shrink()
                    : AppUpdateAvailableWidget(
                        updateCheckController: controller,
                      );
              },
            ),
          ),
        ),
      );

      api.emitPendingUpdate();
      await tester.pump();
      expect(find.text('Later'), findsOneWidget);

      await tester.tap(find.text('Later'));
      await tester.pump();

      expect(find.text('Later'), findsNothing);

      controller.checkForUpdates();
      await tester.pump();

      expect(find.text('Later'), findsNothing);
    });
  });
}
