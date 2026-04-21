sealed class UpdateCheckState {
  const UpdateCheckState(this.version);

  final String version;
}

final class IdleUpdateCheckState extends UpdateCheckState {
  const IdleUpdateCheckState(super.version);
}

final class UpdateAvailableState extends UpdateCheckState {
  const UpdateAvailableState(super.version);
}

final class ApplyingUpdateState extends UpdateCheckState {
  const ApplyingUpdateState(super.version);
}
