import { createAudioPlaylist, setAudioModeAsync } from "expo-audio";
import type { PlaylistPort, PlaylistStatus } from "./engine";

export async function createPlaylist(): Promise<{
  port: PlaylistPort;
  subscribe: (listener: (status: PlaylistStatus) => void) => () => void;
}> {
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
