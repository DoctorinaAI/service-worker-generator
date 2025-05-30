import 'dart:io' as io;
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

Future<void> $platformInitialization() {
  // Compile-time check for initialization:
  return io.Platform.isAndroid || io.Platform.isIOS
      ? _mobileInitialization()
      : _desktopInitialization();
}

Future<void> _mobileInitialization() async {
  // Android and iOS initialization

  // Set the app to be full-screen (no buttons, bar or notifications on top).
  //await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);

  // Check if size of the screen is less than 600 pixels
  // to determine if the device is a phone or a tablet.
  final view = ui.PlatformDispatcher.instance.views.firstOrNull;
  if (view != null) {
    final size = view.physicalSize / view.devicePixelRatio;
    if (size.shortestSide < 600) {
      // If the device is a phone, set the preferred orientation to portrait only.
      await SystemChrome.setPreferredOrientations([
        DeviceOrientation.portraitUp, // Portrait up orientation
        DeviceOrientation.portraitDown, // Portrait down orientation
      ]);
    } else {
      // If the device is a tablet or larger, set the any orientation.
      // This will allow the app to be used in both landscape and portrait modes.
      await SystemChrome.setPreferredOrientations([
        DeviceOrientation.portraitUp, // Portrait up orientation
        DeviceOrientation.landscapeLeft, // Landscape left orientation
        DeviceOrientation.landscapeRight, // Landscape right orientation
        DeviceOrientation.portraitDown, // Portrait down orientation
      ]);
    }
  }
}

/// Desktop initialization for macOS, Linux and Windows platforms.
Future<void> _desktopInitialization() async {
  // macOS, Linux and Windows initialization
}

void $updateLoadingProgress({int progress = 100, String text = ''}) {}

void $removeLoadingWidget() {}
