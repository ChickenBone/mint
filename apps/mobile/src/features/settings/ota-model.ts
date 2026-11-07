export type UpdateStatus = {
  state: "idle" | "checking" | "downloading" | "no-update" | "error" | "ready" | "restarting";
  message: string;
};

export type UpdatesClient = {
  checkForUpdateAsync(): Promise<{ isAvailable: boolean; isRollBackToEmbedded: boolean; reason?: string }>;
  fetchUpdateAsync(): Promise<{ isNew: boolean; isRollBackToEmbedded: boolean }>;
  reloadAsync(): Promise<void>;
};

export type PlaybackActivity = { playing: boolean; loading: boolean; queueLoading: boolean };

export function getUpdateAvailability(
  platform: string,
  executionEnvironment: string,
  updatesEnabled: boolean,
  development: boolean,
): { available: true } | { available: false; message: string } {
  if (platform === "web") {
    return { available: false, message: "App updates are available only in the installed Android or iOS app." };
  }
  if (executionEnvironment === "storeClient") {
    return { available: false, message: "Expo Go and development clients cannot check for production app updates." };
  }
  if (development) {
    return { available: false, message: "App updates cannot be checked from a development build." };
  }
  if (executionEnvironment !== "bare" && executionEnvironment !== "standalone") {
    return { available: false, message: "Use an installed release build to check for app updates." };
  }
  if (!updatesEnabled) {
    return { available: false, message: "App updates are disabled in this build. Install a supported EAS release." };
  }
  return { available: true };
}

export function noUpdateMessage(reason: string | undefined): string {
  switch (reason) {
    case "updateRejectedBySelectionPolicy":
      return "Expo found an update, but it was not eligible for this build.";
    case "updatePreviouslyFailed":
      return "Expo skipped an update that previously failed to launch on this device.";
    case "rollbackRejectedBySelectionPolicy":
      return "Expo found a rollback, but it was not eligible for this build.";
    case "rollbackNoEmbeddedConfiguration":
      return "Expo requested a rollback, but this build has no embedded version to restore.";
    case "noUpdateAvailableOnServer":
    default:
      return "No compatible update is available for this build right now.";
  }
}

export function fetchedUpdateStatus(isNew: boolean, isRollBackToEmbedded: boolean): UpdateStatus {
  if (isRollBackToEmbedded) {
    return { state: "ready", message: "The embedded recovery version is ready. Restart Mint to use it." };
  }
  if (isNew) {
    return { state: "ready", message: "The update is downloaded and ready. Restart Mint to use it." };
  }
  return { state: "no-update", message: "Expo did not download a new update. Mint will keep using its current version." };
}

export function updateErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Expo could not check or download an update. Try again when you have a connection.";
}

export function canRestartForUpdate(playing: boolean, loading: boolean, queueLoading = false): boolean {
  return !playing && !loading && !queueLoading;
}

export async function checkAndFetchUpdate(
  updates: UpdatesClient,
  setStatus: (status: UpdateStatus) => void,
): Promise<void> {
  setStatus({ state: "checking", message: "Checking Expo for an update compatible with this build." });
  try {
    const check = await updates.checkForUpdateAsync();
    if (!check.isAvailable && !check.isRollBackToEmbedded) {
      setStatus({ state: "no-update", message: noUpdateMessage(check.reason) });
      return;
    }
    setStatus({ state: "downloading", message: "Downloading the compatible update. Playback will continue." });
    const fetched = await updates.fetchUpdateAsync();
    setStatus(fetchedUpdateStatus(fetched.isNew, fetched.isRollBackToEmbedded));
  } catch (error) {
    setStatus({ state: "error", message: updateErrorMessage(error) });
  }
}

export async function restartForUpdate(
  updates: Pick<UpdatesClient, "reloadAsync">,
  playback: PlaybackActivity,
  setStatus: (status: UpdateStatus) => void,
): Promise<void> {
  if (!canRestartForUpdate(playback.playing, playback.loading, playback.queueLoading)) {
    setStatus({ state: "ready", message: "Pause playback and wait for queue preparation before restarting Mint." });
    return;
  }
  setStatus({ state: "restarting", message: "Restarting Mint to apply the update." });
  try {
    await updates.reloadAsync();
  } catch (error) {
    setStatus({ state: "error", message: updateErrorMessage(error) });
  }
}
