import 'package:flutter/widgets.dart';
import 'package:sw_example/src/platform/platform_initialization.dart'
    as platform_initialization;

Future<void> initializeApp() async {
  final binding = WidgetsFlutterBinding.ensureInitialized()..deferFirstFrame();
  await platform_initialization.$platformInitialization();

  const offset = 90, steps = 50;
  platform_initialization.$updateLoadingProgress(
    progress: offset,
    text: 'Logic initialization started...',
  );

  // Simulate some initialization logic
  for (var i = 0; i < steps; i++) {
    final progress =
        (offset + (i + 1) * 100 / steps / (100 - offset))
            .clamp(offset, 100)
            .round();
    platform_initialization.$updateLoadingProgress(
      progress: progress,
      text: 'Initialization step $i / $steps',
    );
    await Future.delayed(const Duration(milliseconds: 50));
  }
  platform_initialization.$updateLoadingProgress(
    progress: 100,
    text: 'Initialization complete!',
  );

  // Finalize initialization and allow the first frame to be drawn.
  binding.addPostFrameCallback((_) {
    binding.allowFirstFrame();
    platform_initialization.$removeLoadingWidget();
  });
}
