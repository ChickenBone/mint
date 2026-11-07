import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Button, Notice } from "../components/ui/primitives";
import { View } from "react-native";
import { colors } from "../theme/tokens";

const PlaybackActionContext = createContext<((action: () => Promise<unknown>) => void) | null>(null);

export function PlaybackActionProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((action: () => Promise<unknown>) => {
    setError(null);
    void action().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Playback could not start. Try again.");
    });
  }, []);
  return <PlaybackActionContext.Provider value={run}>
    {error ? <View style={{ paddingHorizontal: 20, paddingVertical: 8, backgroundColor: colors.background }}><Notice title="Playback needs attention" message={error} />
      <Button label="Dismiss" quiet onPress={() => setError(null)} /></View> : null}
    {children}
  </PlaybackActionContext.Provider>;
}

export function usePlaybackAction() {
  const run = useContext(PlaybackActionContext);
  if (!run) throw new Error("PlaybackActionProvider is required.");
  return run;
}
