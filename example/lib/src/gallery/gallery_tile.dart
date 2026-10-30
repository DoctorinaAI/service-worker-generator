import 'package:flutter/material.dart';
import 'package:sw_example/src/gallery/gallery_item.dart';

/// How the worker treats a tile's file right now.
enum TileStatus {
  /// Stored: the next load will not touch the network.
  cached('In cache', Icons.check_circle, Color(0xFF25D366)),

  /// Not stored yet: the worker stores it on first fetch.
  network('From network', Icons.cloud_download_outlined, Color(0xFFFFC857)),

  /// Over the limit: the worker never stores it.
  skipped('Too big to cache', Icons.block, Color(0xFFFF8A80));

  const TileStatus(this.label, this.icon, this.color);

  /// Text on the tile.
  final String label;

  /// Icon on the tile.
  final IconData icon;

  /// Color of the icon.
  final Color color;

  /// The status of [item], given the [files] in the cache.
  static TileStatus of(GalleryItem item, Set<String> files) {
    if (!item.cacheable) return TileStatus.skipped;
    return files.contains(item.cacheKey) ? TileStatus.cached : TileStatus.network;
  }
}

/// A picture with its format, size and cache status.
class GalleryTile extends StatelessWidget {
  /// Creates a tile.
  const GalleryTile({
    required this.item,
    required this.status,
    required this.onTap,
    super.key,
  });

  /// The picture.
  final GalleryItem item;

  /// Its cache status.
  final TileStatus status;

  /// Called when the tile is tapped.
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final decodeWidth = (360 * MediaQuery.devicePixelRatioOf(context)).round();
    return Semantics(
      button: true,
      label: '${item.title}, ${item.format}, ${status.label}',
      child: Card(
        clipBehavior: Clip.antiAlias,
        margin: EdgeInsets.zero,
        child: InkWell(
          onTap: onTap,
          child: Stack(
            fit: StackFit.expand,
            children: [
              ColoredBox(color: Theme.of(context).colorScheme.surfaceContainerHighest),
              Image.asset(
                item.asset,
                fit: BoxFit.cover,
                cacheWidth: decodeWidth,
                frameBuilder: (context, child, frame, wasSynchronous) =>
                    AnimatedOpacity(
                      opacity: frame == null && !wasSynchronous ? 0 : 1,
                      duration: const Duration(milliseconds: 300),
                      child: child,
                    ),
                errorBuilder: (context, error, stackTrace) =>
                    const Center(child: Icon(Icons.broken_image_outlined)),
              ),
              const Positioned.fill(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      stops: [0.45, 1],
                      colors: [Colors.transparent, Color(0xCC000000)],
                    ),
                  ),
                ),
              ),
              Positioned(
                left: 12,
                right: 12,
                bottom: 10,
                child: DefaultTextStyle.merge(
                  style: const TextStyle(color: Colors.white),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        item.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${item.format} · ${formatBytes(item.bytes)}',
                        style: const TextStyle(fontSize: 12, color: Colors.white70),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Icon(status.icon, size: 14, color: status.color),
                          const SizedBox(width: 4),
                          Expanded(
                            child: Text(
                              status.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
