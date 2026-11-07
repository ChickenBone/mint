import { createAudioPlaylist, setAudioModeAsync } from "expo-audio";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import type { PlaylistPort, PlaylistStatus } from "./engine";

export const EXPO_GO_PLAYBACK_ERROR = "Expo Go can't play Mint songs on Android. Install the Mint APK to listen.";

export async function createPlaylist(): Promise<{
  port: PlaylistPort;
  subscribe: (listener: (status: PlaylistStatus) => void) => () => void;
}> {
  // Expo Go ships stock expo-audio without the with-audio-playlist.cjs patch, so
  // Android playlist requests would drop the Authorization header. Refuse before
  // touching native audio instead of streaming unauthenticated or crashing.
  if (Platform.OS === "android" && Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    throw new Error(EXPO_GO_PLAYBACK_ERROR);
  }
  await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true,
    interruptionMode: "doNotMix", allowsRecording: false, allowsBackgroundRecording: false });
  const playlist = createAudioPlaylist({ sources: [], updateInterval: 250, loop: "none" });
  return {
    port: playlist,
    subscribe(listener) {
      const subscription = playlist.addListener("playlistStatusUpdate", listener);
      return () => subscription.remove();
    },
  };
}
