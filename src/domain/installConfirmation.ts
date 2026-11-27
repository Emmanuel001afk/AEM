export interface InstallConfirmation {
  targetVersionCode: number;
  previousVersionCode?: number;
  previousLastUpdateTime?: number;
  installedVersionCode: number;
  installedLastUpdateTime?: number;
}

/** Confirm the requested version, not merely a newer app already on the device. */
export function isInstallConfirmed(state: InstallConfirmation): boolean {
  const {targetVersionCode, previousVersionCode, previousLastUpdateTime, installedVersionCode, installedLastUpdateTime} = state;
  if (targetVersionCode <= 0 || installedVersionCode !== targetVersionCode) return false;
  if (previousVersionCode !== targetVersionCode) return true;
  // A same-version replacement needs evidence that Android changed the package.
  return (installedLastUpdateTime || 0) > 0 && (installedLastUpdateTime || 0) > (previousLastUpdateTime || 0);
}

/** Recover a history row only when package-manager evidence is newer than the attempt. */
export function isRecoveredInstallConfirmed(targetCode: number, installedCode: number, attemptCreatedAt: number, installedUpdatedAt: number): boolean {
  return targetCode > 0 && installedCode === targetCode && attemptCreatedAt > 0 && installedUpdatedAt > 0 && installedUpdatedAt >= attemptCreatedAt;
}
