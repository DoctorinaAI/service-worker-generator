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
  Widget build(BuildContext context) =>
      const MaterialApp(title: 'Application', home: CounterScreen());
}

/// {@template counter_screen}
/// Screen with a counter button to verify canvas interactivity.
/// {@endtemplate}
class CounterScreen extends StatefulWidget {
  /// {@macro counter_screen}
  const CounterScreen({super.key});

  @override
  State<CounterScreen> createState() => _CounterScreenState();
}

class _CounterScreenState extends State<CounterScreen> {
  int _count = 0;

  void _increment() => setState(() => _count++);

  void _reset() => setState(() => _count = 0);

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Application'),
      actions: [
        IconButton(
          onPressed: _count == 0 ? null : _reset,
          icon: const Icon(Icons.refresh),
          tooltip: 'Reset',
        ),
      ],
    ),
    body: SafeArea(
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('$_count', style: Theme.of(context).textTheme.displayLarge),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _increment,
              icon: const Icon(Icons.add),
              label: const Text('Increment'),
            ),
          ],
        ),
      ),
    ),
    floatingActionButton: FloatingActionButton(
      onPressed: _increment,
      tooltip: 'Increment',
      child: const Icon(Icons.add),
    ),
  );
}
