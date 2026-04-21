import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:sw_example/src/update/update_check_controller.dart';
import 'package:sw_example/src/update/update_check_state.dart';

class AppUpdateAvailableWidget extends StatelessWidget {
  const AppUpdateAvailableWidget({
    super.key,
    required this.updateCheckController,
  });

  final UpdateCheckController updateCheckController;

  @override
  Widget build(BuildContext context) {
    final updateState = updateCheckController.state;
    final isApplying = updateState is ApplyingUpdateState;

    return MaterialBanner(
      leading: Icon(
        Icons.cloud_download_outlined,
        color: Theme.of(context).colorScheme.onSecondaryContainer,
      ),
      content: Text.rich(
        TextSpan(
          text:
              'A new version (v${updateState.version}) of the app is available.\n',
          style: Theme.of(context).textTheme.bodyLarge,
          children: [
            TextSpan(
              text: isApplying
                  ? 'Applying the update and reloading the page...'
                  : 'Please update to continue for the best experience.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      ),
      actions: [
        FilledButton(
          onPressed: isApplying
              ? null
              : () {
                  HapticFeedback.mediumImpact().ignore();
                  unawaited(updateCheckController.update());
                },
          child: Text(isApplying ? 'Updating...' : 'Update Now'),
        ),
        TextButton(
          onPressed: isApplying
              ? null
              : () {
                  HapticFeedback.mediumImpact().ignore();
                  updateCheckController.ignoreUpdate();
                },
          child: const Text('Later'),
        ),
      ],
    );
  }
}
