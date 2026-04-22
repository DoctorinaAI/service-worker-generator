import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sw_example/src/initialization.dart';
import 'package:sw_example/src/update/app_update_available_widget.dart';
import 'package:sw_example/src/update/platform/update_check.dart';
import 'package:sw_example/src/update/update_check_controller.dart';
import 'package:sw_example/src/update/update_check_state.dart';

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

  @override
  Widget build(BuildContext context) => const MaterialApp(title: 'Application', home: CounterScreen());
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
  static const String _appVersion = String.fromEnvironment('APP_VERSION', defaultValue: '1.0.0');

  int _count = 0;
  late final UpdateCheckController _updateCheckController;

  @override
  void initState() {
    super.initState();
    _updateCheckController = UpdateCheckController(updateCheckApi: createUpdateCheckApi(), version: _appVersion);
    _updateCheckController.checkForUpdates();
  }

  void _increment() => setState(() => _count++);

  void _reset() => setState(() => _count = 0);

  @override
  void dispose() {
    _updateCheckController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Application'),
      actions: [IconButton(onPressed: _count == 0 ? null : _reset, icon: const Icon(Icons.refresh), tooltip: 'Reset')],
    ),
    body: SafeArea(
      child: ListenableBuilder(
        listenable: _updateCheckController,
        builder: (context, _) => Column(
          children: [
            if (_updateCheckController.state is! IdleUpdateCheckState)
              AppUpdateAvailableWidget(updateCheckController: _updateCheckController),
            Expanded(
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
