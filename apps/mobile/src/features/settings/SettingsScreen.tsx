import { useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useAuth } from "../../auth";
import { useApi } from "../../api";
import { Button, Field, Notice, Section } from "../../components/ui/primitives";
import { useResource } from "../../hooks/useResource";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors } from "../../theme/tokens";
import { screenStyles } from "../../components/music/screen-styles";
import { usePlaybackAction } from "../../hooks/usePlaybackAction";
import {
  checkAndFetchUpdate,
  canRestartForUpdate,
  getUpdateAvailability,
  restartForUpdate,
  updateErrorMessage,
  type UpdateStatus,
} from "./ota-model";

export function SettingsScreen() {
  const auth = useAuth();
  const api = useApi();
  const player = usePlayer();
  const runPlayback = usePlaybackAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [report, setReport] = useState("");
  const [confirm, setConfirm] = useState<"history" | "downloads" | "logout" | "update" | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle", message: "Check for a compatible update when you are ready." });
  const nativeUpdates = Updates.useUpdates();
  const updateAvailability = getUpdateAvailability(Platform.OS, Constants.executionEnvironment, Updates.isEnabled, __DEV__);
  const nativeBuild = Platform.OS === "android" ? "Not exposed by SDK 58 Constants" :
    Platform.OS === "ios" ? Constants.platform?.ios?.buildNumber ?? "Not available" : "Not available";
  const automaticUpdateStatus: UpdateStatus = nativeUpdates.isUpdatePending
    ? { state: "ready", message: "An update downloaded at launch is ready. Restart Mint to use it." }
    : nativeUpdates.downloadError
      ? { state: "error", message: updateErrorMessage(nativeUpdates.downloadError) }
      : nativeUpdates.checkError
        ? { state: "error", message: updateErrorMessage(nativeUpdates.checkError) }
        : nativeUpdates.isDownloading
          ? { state: "downloading", message: "Downloading a compatible update. Playback will continue." }
          : nativeUpdates.isChecking
            ? { state: "checking", message: "Checking Expo for an update compatible with this build." }
            : { state: "idle", message: "" };
  const visibleUpdateStatus = updateStatus.state === "idle" ? automaticUpdateStatus : updateStatus;
  const updateReady = updateStatus.state === "ready" || nativeUpdates.isUpdatePending;
  const updateBusy = visibleUpdateStatus.state === "checking" || visibleUpdateStatus.state === "downloading" || visibleUpdateStatus.state === "restarting";
  const preferences = useResource(async () => {
    if (!api) throw new Error("Sign in to load account preferences.");
    return api.preferences();
  }, [api]);
  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); setMessage(success); preferences.reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The setting could not be saved. Try again."); }
    finally { setBusy(false); setConfirm(null); }
  }
  async function confirmed() {
    if (confirm === "history" && api) await act(() => api.deleteHistory(), "Listening history deleted.");
    else if (confirm === "downloads") await act(() => player.clearDownloads(), "Downloaded songs removed from this device.");
    else if (confirm === "logout") await act(() => auth.signOut(), "");
    else if (confirm === "update") {
      setConfirm(null);
      await restartForUpdate(Updates, player.state, setUpdateStatus);
    }
  }
  async function checkForUpdates() {
    await checkAndFetchUpdate(Updates, setUpdateStatus);
  }
  return <ScrollView contentContainerStyle={screenStyles.page} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header" style={screenStyles.heading}>Settings</Text>
    <Section title="Account"><Text style={s.title}>{auth.user?.name}</Text><Text style={s.secondary}>{auth.user?.email}</Text>
      <Text style={s.secondary}>Connected to {auth.serverUrl}</Text>
      <Button label="Sign out" quiet disabled={busy} onPress={() => setConfirm("logout")} /></Section>
    <Section title="Privacy">
      {preferences.loading ? <Notice loading /> : preferences.error ? <Notice title="Couldn't load privacy settings" message={preferences.error} retry={preferences.reload} /> :
        preferences.data ? <View style={s.setting}><View style={s.settingText}><Text style={s.title}>Private session</Text>
          <Text style={s.secondary}>Do not save listening history or use this session for recommendations.</Text></View>
          <Switch accessibilityLabel="Private session" value={preferences.data.privateSession} disabled={busy} trackColor={{ false: colors.line, true: colors.action }}
            onValueChange={(value) => { if (api) void act(() => api.setPrivateSession(value), value ? "Private session is on." : "Private session is off."); }} /></View> : null}
      <Button label="Delete listening history" quiet disabled={busy || !api} onPress={() => setConfirm("history")} />
    </Section>
    <Section title="Playback">
      <View style={s.setting}><View style={s.settingText}><Text style={s.title}>MP3 compatibility</Text>
        <Text style={s.secondary}>Use an MP3 stream if your device cannot play the original format. Original server files and offline downloads are unchanged.</Text></View>
        <Switch accessibilityLabel="MP3 compatibility" value={player.format === "mp3"}
          trackColor={{ false: colors.line, true: colors.action }} onValueChange={(value) => runPlayback(() => player.setFormat(value ? "mp3" : "original"))} />
      </View>
      <Text style={s.secondary}>Original audio is the default. Background playback is {player.capabilities.nativeBackground ? "supported by this native build" : "limited by this browser"}.</Text>
      <Text style={s.secondary}>Equalizer, Smart Fades and guaranteed gapless playback are not available in this app. They are not silently enabled.</Text>
    </Section>
    <Section title="Download storage">
      <Text style={s.secondary}>{(player.offline.bytes / 1024 / 1024).toFixed(1)} MB used · {(player.offline.budgetBytes / 1024 / 1024).toFixed(0)} MB limit</Text>
      <Text style={s.secondary}>Downloads are stored on this device for this account. Use song options to download audio. Signing out removes saved audio.</Text>
      {!player.capabilities.offline ? <Notice title="Downloads aren't available here" message="Use the native app on a supported device for offline listening." /> : null}
      {player.offline.error ? <Notice title="Download storage needs attention" message={player.offline.error} /> : null}
      {player.offline.entries.map((entry) => <View key={entry.id} style={s.download}>
        <View style={s.settingText}><Text numberOfLines={1} style={s.title}>{entry.title}</Text>
          <Text style={s.secondary}>{entry.status === "ready" ? "Saved for offline listening" : entry.status === "queued" ? "Waiting to download" : entry.status === "downloading" ? "Downloading" : "Download failed"}</Text>
          {entry.error ? <Text style={s.secondary}>{entry.error}</Text> : null}
        </View>
        {entry.status === "failed" ? <Button label="Retry" quiet disabled={busy} onPress={() => void act(() => player.retryDownload(entry.id), "Download retry started.")} /> : null}
        <Button label="Remove" quiet disabled={busy} onPress={() => void act(() => player.removeDownload(entry.id), "Removed from this device.")} />
      </View>)}
      <Button label="Remove downloaded songs" quiet disabled={!player.capabilities.offline || busy || !player.offline.entries.length} onPress={() => setConfirm("downloads")} />
    </Section>
    <Section title="Report a problem">
      <Text style={s.secondary}>Only the message you write is sent to your server owner. Audio, private device details and listening history are not attached.</Text>
      <Field label="What happened?" value={report} onChangeText={setReport} multiline maxLength={2000} style={{ minHeight: 112, textAlignVertical: "top" }} />
      <Button label="Send report" disabled={!report.trim() || !api || busy} onPress={() => api && void act(async () => {
        await api.reportIssue({ category: "app", message: report.trim() }); setReport("");
      }, "Your report was sent to the server owner.")} />
    </Section>
    <Section title="App info">
      <Text selectable style={s.secondary}>App config version (may be from the current update): {Constants.expoConfig?.version ?? "Not available"}</Text>
      <Text selectable style={s.secondary}>Installed native build: {nativeBuild}</Text>
      <Text selectable style={s.secondary}>Runtime: {Updates.runtimeVersion ?? "Not available"}</Text>
      <Text selectable style={s.secondary}>Channel: {Updates.channel ?? "Not set"}</Text>
      <Text selectable style={s.secondary}>Running update: {Updates.updateId ?? "Not available"}</Text>
      <Text selectable style={s.secondary}>Downloaded update: {nativeUpdates.isUpdatePending
        ? nativeUpdates.downloadedUpdate?.type === "rollback" ? "Embedded recovery is ready" : nativeUpdates.downloadedUpdate?.updateId ?? "Ready to apply"
        : "None waiting to apply"}</Text>
      <Text style={s.secondary}>Launch: {Updates.isEnabled ? Updates.isEmbeddedLaunch ? "Embedded in this app build" : "Downloaded update" : "Expo Updates unavailable"}</Text>
      <Text style={s.secondary}>Recovery: {Updates.isEnabled ? Updates.isEmergencyLaunch ? "Emergency recovery launch" : "No emergency recovery reported" : "Not available"}</Text>
      {Updates.isEmergencyLaunch && Updates.emergencyLaunchReason
        ? <Text selectable style={s.secondary}>Recovery detail: {Updates.emergencyLaunchReason}</Text> : null}
      <Text style={s.secondary}>OTA enabled: {Updates.isEnabled ? "Yes" : "No"} · Startup check: {Updates.checkAutomatically ?? "Not available"}</Text>
      {!updateAvailability.available ? <Notice title="Manual update check unavailable" message={updateAvailability.message} /> : <>
        <Text style={s.secondary}>A downloaded update is applied only after you choose to restart. Mint will not interrupt playback.</Text>
        <Button label="Check for updates" quiet busy={updateBusy} disabled={updateBusy} onPress={() => void checkForUpdates()} />
        {visibleUpdateStatus.state !== "idle" ? <Notice
          title={visibleUpdateStatus.state === "error" ? "Update check failed" : visibleUpdateStatus.state === "no-update" ? "No update available" :
            visibleUpdateStatus.state === "ready" ? "Update ready" : visibleUpdateStatus.state === "restarting" ? "Restarting Mint" :
              visibleUpdateStatus.state === "downloading" ? "Downloading update" : "Checking for updates"}
          message={visibleUpdateStatus.message}
          loading={updateBusy}
        /> : null}
        {updateReady ? <>
          {!canRestartForUpdate(player.state.playing, player.state.loading, player.state.queueLoading)
            ? <Text style={s.secondary}>Pause playback and wait for queue preparation before restarting to apply this update.</Text> : null}
          <Button label="Restart Mint" disabled={!canRestartForUpdate(player.state.playing, player.state.loading, player.state.queueLoading)}
            onPress={() => setConfirm("update")} />
        </> : null}
      </>}
    </Section>
    {error ? <Notice title="Couldn't finish" message={error} /> : message ? <Notice message={message} /> : null}
    <Modal transparent visible={confirm !== null} animationType="none" onRequestClose={() => { if (!busy) setConfirm(null); }}>
      <View style={s.overlay}><View accessibilityViewIsModal style={s.dialog}>
        <Text accessibilityRole="header" style={s.dialogTitle}>{confirm === "history" ? "Delete listening history?" : confirm === "downloads" ? "Remove all downloads?" : confirm === "update" ? "Restart Mint to apply the update?" : "Sign out?"}</Text>
        <Text style={s.secondary}>{confirm === "history" ? "This removes your listening history across devices. It doesn't remove likes or playlists." :
          confirm === "downloads" ? "Saved audio will be removed from this device. Your server library stays untouched." :
            confirm === "update" ? "Mint will restart and activate the downloaded update. Your account and downloaded songs will be kept. Playback must be paused first." :
              "Playback will stop and downloaded audio will be removed from this device."}</Text>
        <View style={screenStyles.shortcuts}><Button label={confirm === "logout" ? "Sign out" : confirm === "update" ? "Restart now" : "Remove"}
          busy={confirm === "update" ? updateBusy : busy}
          disabled={confirm === "update" ? !canRestartForUpdate(player.state.playing, player.state.loading, player.state.queueLoading) : busy}
          onPress={() => void confirmed()} />
          <Button label="Cancel" quiet disabled={busy} onPress={() => setConfirm(null)} /></View>
      </View></View>
    </Modal>
  </ScrollView>;
}

const s = StyleSheet.create({
  title: { color: colors.text, fontSize: 16, fontWeight: "600" }, secondary: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  setting: { flexDirection: "row", alignItems: "center", gap: 20 }, settingText: { flex: 1, gap: 6 },
  download: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12, paddingVertical: 12 },
  overlay: { flex: 1, backgroundColor: "#000000b3", justifyContent: "center", padding: 24 },
  dialog: { padding: 24, backgroundColor: colors.surface, borderRadius: 16, gap: 20, maxWidth: 440, width: "100%", alignSelf: "center" },
  dialogTitle: { color: colors.text, fontSize: 24, fontWeight: "700" },
});
