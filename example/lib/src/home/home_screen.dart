import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:sw_example/src/cache/cache_snapshot.dart';
import 'package:sw_example/src/cache/cache_status_controller.dart';
import 'package:sw_example/src/cache/platform/cache_inspector.dart' as cache_inspector;
import 'package:sw_example/src/gallery/gallery_item.dart';
import 'package:sw_example/src/gallery/gallery_tile.dart';
import 'package:sw_example/src/home/hero_background.dart';
import 'package:sw_example/src/update/app_update_available_widget.dart';
import 'package:sw_example/src/update/platform/update_check.dart';
import 'package:sw_example/src/update/update_check_controller.dart';
import 'package:sw_example/src/update/update_check_state.dart';

const String _repositoryUrl = 'https://github.com/DoctorinaAI/service-worker-generator';
const String _packageUrl = 'https://pub.dev/packages/sw';

/// From the bundled Font Awesome: the regular-weight star.
const IconData _starIcon = IconData(0xf005, fontFamily: 'FontAwesome');

/// {@template home_screen}
/// The example's page: what the generated worker is doing, on real files.
/// {@endtemplate}
class HomeScreen extends StatefulWidget {
  /// {@macro home_screen}
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  static const String _appVersion = String.fromEnvironment('APP_VERSION', defaultValue: '1.0.0');

  late final UpdateCheckController _updateCheckController;
  late final CacheStatusController _cacheStatus;
  late final Future<List<GalleryItem>> _gallery;

  @override
  void initState() {
    super.initState();
    _updateCheckController = UpdateCheckController(updateCheckApi: createUpdateCheckApi(), version: _appVersion);
    _updateCheckController.checkForUpdates();
    _cacheStatus = CacheStatusController(read: cache_inspector.readCacheSnapshot)..start();
    _gallery = rootBundle.loadString('assets/data/gallery.json').then(GalleryItem.parseAll);
  }

  @override
  void dispose() {
    _updateCheckController.dispose();
    _cacheStatus.dispose();
    super.dispose();
  }

  void _open(GalleryItem item) => showDialog<void>(
    context: context,
    builder: (context) => Dialog(
      clipBehavior: Clip.antiAlias,
      child: Stack(
        children: [
          InteractiveViewer(child: Image.asset(item.asset, fit: BoxFit.contain)),
          Positioned(
            top: 8,
            right: 8,
            child: IconButton.filledTonal(
              onPressed: () => Navigator.pop(context),
              icon: const Icon(Icons.close),
              tooltip: 'Close',
            ),
          ),
        ],
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final gutter = width > 1232 ? (width - 1200) / 2 : 16.0;
    final padding = EdgeInsets.symmetric(horizontal: gutter);
    return Scaffold(
      body: FutureBuilder<List<GalleryItem>>(
        future: _gallery,
        builder: (context, gallery) => ValueListenableBuilder<CacheSnapshot>(
          valueListenable: _cacheStatus,
          builder: (context, snapshot, _) {
            final items = gallery.data ?? const <GalleryItem>[];
            return CustomScrollView(
              slivers: [
                SliverToBoxAdapter(
                  child: ListenableBuilder(
                    listenable: _updateCheckController,
                    builder: (context, _) => _updateCheckController.state is IdleUpdateCheckState
                        ? const SizedBox.shrink()
                        : AppUpdateAvailableWidget(updateCheckController: _updateCheckController),
                  ),
                ),
                SliverToBoxAdapter(child: _Hero(padding: padding)),
                SliverPadding(
                  padding: padding.copyWith(top: 24, bottom: 8),
                  sliver: SliverToBoxAdapter(child: _Stats(snapshot: snapshot, items: items)),
                ),
                SliverPadding(
                  padding: padding.copyWith(top: 24, bottom: 12),
                  sliver: const SliverToBoxAdapter(
                    child: _Heading(
                      title: 'Cached as you scroll',
                      subtitle:
                          'Every picture is an Optional file: the worker stores it on first fetch. '
                          'Scroll and watch the labels change, then reload and find no requests for them.',
                    ),
                  ),
                ),
                SliverPadding(
                  padding: padding,
                  sliver: SliverGrid.builder(
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 300,
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                      childAspectRatio: 4 / 3,
                    ),
                    itemCount: items.length,
                    itemBuilder: (context, index) => GalleryTile(
                      item: items[index],
                      status: TileStatus.of(items[index], snapshot.files),
                      onTap: () => _open(items[index]),
                    ),
                  ),
                ),
                SliverPadding(
                  padding: padding.copyWith(top: 32, bottom: 32),
                  sliver: const SliverToBoxAdapter(child: _TryIt()),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.padding});

  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Stack(
      children: [
        const Positioned.fill(child: HeroBackground()),
        Padding(
          padding: padding.copyWith(top: 56, bottom: 48),
          child: DefaultTextStyle.merge(
            style: const TextStyle(color: Colors.white),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Service Worker Generator',
                  style: theme.textTheme.displaySmall?.copyWith(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 640),
                  child: Text(
                    'A loading screen with real progress, smart caching and safe updates for '
                    'Flutter Web. This page runs on it: everything below is read live from '
                    'your browser.',
                    style: theme.textTheme.titleMedium?.copyWith(color: Colors.white),
                  ),
                ),
                const SizedBox(height: 24),
                Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    FilledButton.icon(
                      onPressed: () => cache_inspector.openLink(_repositoryUrl),
                      icon: const Icon(_starIcon, size: 16),
                      label: const Text('GitHub'),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF25D366),
                        foregroundColor: const Color(0xFF06281F),
                      ),
                    ),
                    OutlinedButton.icon(
                      onPressed: () => cache_inspector.openLink(_packageUrl),
                      icon: const Icon(Icons.inventory_2_outlined, size: 18),
                      label: const Text('pub.dev'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: Colors.white,
                        side: const BorderSide(color: Colors.white70),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Stats extends StatelessWidget {
  const _Stats({required this.snapshot, required this.items});

  final CacheSnapshot snapshot;
  final List<GalleryItem> items;

  @override
  Widget build(BuildContext context) {
    final cacheable = items.where((item) => item.cacheable).toList(growable: false);
    final stored = cacheable.where((item) => snapshot.files.contains(item.cacheKey)).length;
    final usage = snapshot.usageBytes;
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 840 ? 4 : (constraints.maxWidth >= 340 ? 2 : 1);
        final cardWidth = (constraints.maxWidth - 12 * (columns - 1)) / columns;
        return Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            for (final card in <Widget>[
              _StatCard(
                icon: snapshot.controlled ? Icons.verified_outlined : Icons.hourglass_empty,
                label: 'Service worker',
                value: snapshot.controlled ? 'In control' : 'Not yet',
                caption: snapshot.version == null ? 'Takes over after install' : 'Version ${snapshot.version}',
              ),
              _StatCard(
                icon: Icons.folder_copy_outlined,
                label: 'Files in cache',
                value: '${snapshot.files.length}',
                caption: 'App code, assets and what you opened',
              ),
              _StatCard(
                icon: Icons.storage_outlined,
                label: 'Storage used',
                value: usage == null ? 'Unknown' : formatBytes(usage),
                caption: 'As the browser estimates it',
              ),
              _StatCard(
                icon: Icons.photo_library_outlined,
                label: 'Gallery cached',
                value: '$stored of ${cacheable.length}',
                caption: 'Plus one file too big to store',
              ),
            ])
              SizedBox(width: cardWidth, child: card),
          ],
        );
      },
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.icon,
    required this.label,
    required this.value,
    required this.caption,
  });

  final IconData icon;
  final String label;
  final String value;
  final String caption;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 18, color: theme.colorScheme.primary),
                const SizedBox(width: 8),
                Expanded(child: Text(label, style: theme.textTheme.labelLarge)),
              ],
            ),
            const SizedBox(height: 8),
            Text(value, style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(
              caption,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: Text(
            subtitle,
            style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}

class _TryIt extends StatelessWidget {
  const _TryIt();

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const _Heading(
        title: 'Try it',
        subtitle:
            'Clear the caches to do what a browser does under disk pressure. The next load '
            'restores what it needs, one file at a time.',
      ),
      const SizedBox(height: 16),
      Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          FilledButton.tonalIcon(
            onPressed: cache_inspector.clearCachesAndReload,
            icon: const Icon(Icons.delete_sweep_outlined),
            label: const Text('Clear caches and reload'),
          ),
        ],
      ),
      const SizedBox(height: 24),
      const _Heading(
        title: 'Use it',
        subtitle: 'Run it after your Flutter build. It writes sw.js and bootstrap.js next to your app.',
      ),
      const SizedBox(height: 12),
      const SizedBox(
        width: double.infinity,
        child: Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: EdgeInsets.all(16),
            child: SelectableText(
              'dart pub add dev:sw\n'
              'flutter build web --release --wasm -o build/web\n'
              'dart run sw:generate --input=build/web',
              style: TextStyle(fontFamily: 'monospace', height: 1.5),
            ),
          ),
        ),
      ),
    ],
  );
}
