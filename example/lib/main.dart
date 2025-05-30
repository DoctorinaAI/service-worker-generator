import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sw_example/src/initialization.dart';

void main() => runZonedGuarded<void>(
  () async {
    await initializeApp();
    runApp(const App());
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
