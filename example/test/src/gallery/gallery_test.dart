import 'package:flutter_test/flutter_test.dart';
import 'package:sw_example/src/cache/cache_snapshot.dart';
import 'package:sw_example/src/cache/cache_status_controller.dart';
import 'package:sw_example/src/gallery/gallery_item.dart';
import 'package:sw_example/src/gallery/gallery_tile.dart';

void main() {
  const small = GalleryItem(asset: 'assets/images/a.webp', title: 'A', bytes: 2048);
  const large = GalleryItem(
    asset: 'assets/images/b.PNG',
    title: 'B',
    bytes: optionalImageLimitBytes + 1,
  );

  test('reads the gallery file', () {
    final items = GalleryItem.parseAll(
      '[{"asset":"assets/images/a.webp","title":"A","bytes":2048}]',
    );
    expect(items.single.cacheKey, 'assets/assets/images/a.webp');
    expect(items.single.format, 'WEBP');
    expect(items.single.bytes, 2048);
  });

  test('a tile follows the cache, and a file over the limit never does', () {
    expect(TileStatus.of(small, {}), TileStatus.network);
    expect(TileStatus.of(small, {small.cacheKey}), TileStatus.cached);
    expect(TileStatus.of(large, {large.cacheKey}), TileStatus.skipped);
  });

  test('sizes read in the right unit', () {
    expect(formatBytes(512), '512 B');
    expect(formatBytes(2048), '2 KB');
    expect(formatBytes(3 * 1024 * 1024), '3.0 MB');
  });

  test('the status controller stops publishing once disposed', () async {
    var reads = 0;
    final controller = CacheStatusController(
      read: () async => CacheSnapshot(usageBytes: ++reads),
      interval: const Duration(hours: 1),
    )..start();
    await pumpEventQueue();
    expect(controller.value.usageBytes, 1);

    final pending = controller.refresh();
    controller.dispose();
    await pending;
    expect(reads, 2);
  });
}
