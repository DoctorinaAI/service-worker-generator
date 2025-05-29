import 'dart:async';

import 'package:flutter/material.dart';

void main() => runZonedGuarded<void>(
  () async {
    final binding =
        WidgetsFlutterBinding.ensureInitialized()..deferFirstFrame();
    for (var i = 0; i < 100; i++) {
      // Simulate initialization
      await Future.delayed(const Duration(milliseconds: 25));
    }
    runApp(const App());
    binding.addPostFrameCallback((_) {
      binding.allowFirstFrame();
    });
  },
  (error, stackTrace) =>
      print('Top level exception: $error'), // ignore: avoid_print
);

/// {@template app}
/// App widget.
/// {@endtemplate}
class App extends StatelessWidget {
  /// {@macro app}
  const App({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Application',
    home: Scaffold(
      appBar: AppBar(title: const Text('Application')),
      body: const SafeArea(child: Center(child: Text('Hello World'))),
    ),
  );
}
