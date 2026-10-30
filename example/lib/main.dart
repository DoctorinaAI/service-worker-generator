import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sw_example/src/home/home_screen.dart';
import 'package:sw_example/src/initialization.dart';

void main() => runZonedGuarded<void>(
  () async {
    await initializeApp();
    runApp(const App());
  },
  (error, stackTrace) => print('Top level exception: $error'), // ignore: avoid_print
);

/// {@template app}
/// App widget.
/// {@endtemplate}
class App extends StatelessWidget {
  /// {@macro app}
  const App({super.key});

  static const Color _brand = Color(0xFF25D366);

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Service Worker Generator',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(colorSchemeSeed: _brand),
    darkTheme: ThemeData(colorSchemeSeed: _brand, brightness: Brightness.dark),
    home: const HomeScreen(),
  );
}
