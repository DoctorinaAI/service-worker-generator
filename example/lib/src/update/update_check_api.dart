import 'dart:async';

/// Contract for the update-check surface area consumed by
/// `UpdateCheckController`. The shape is intentionally minimal: the
/// controller only needs to know "is there a newer Service Worker
/// waiting?" and "fire when one appears".
abstract class UpdateCheckApi {
  /// `true` once a newer Service Worker has finished installing and is
  /// waiting to take control, as signalled through
  /// `Bootstrap.onUpdateAvailable` (sw 0.1.x's post-install event).
  bool get hasPendingUpdate;

  /// Fires whenever a newer Service Worker becomes available. The
  /// controller listens to this so the banner appears in seconds rather
  /// than waiting for any periodic check.
  Stream<void> get onUpdateAvailable;

  /// Apply a pending update — under sw 0.1.x this drives the
  /// skipWaiting / controllerchange / reload handshake.
  ///
  /// Implementations must either start the reload/update handoff or throw;
  /// silent no-op success leaves the UI stuck in an "updating" state.
  Future<void> updateApplication();

  /// Release timers, listeners and stream resources. Idempotent.
  void dispose();
}
