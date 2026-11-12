import { useState } from "react";
import type { TrackSourceState } from "@mint/client";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useApi } from "../../api";
import { colors } from "../../theme/tokens";
import { Button, Notice } from "../../components/ui/primitives";
import { sourceChoiceSummary } from "./playlist-model";

/** Lets a member pick one of the worker's reviewed uploads when an import needs a source. */
export function SourcePicker({ trackId, title, onChosen }: { trackId: string; title: string; onChosen: () => void }) {
  const api = useApi();
  const [state, setState] = useState<TrackSourceState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(task: () => Promise<TrackSourceState>) {
    setBusy(true); setError(null);
    try { const next = await task(); setState(next); if (next.stage !== "failed") onChosen(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The source could not be changed. Try again."); }
    finally { setBusy(false); }
  }
  if (!api) return null;
  return <View style={s.root}>
    <Button label={open ? "Hide sources" : "Choose source"} quiet busy={busy && !state} disabled={busy}
      onPress={() => { setOpen(!open); if (!open && !state) void run(() => api.trackSource(trackId)); }} />
    {open && state ? state.choices.length ? state.choices.map((choice) => <View key={choice.id} style={s.choice}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Use ${choice.title}, ${sourceChoiceSummary(choice)}`} disabled={busy}
        onPress={() => void run(() => api.chooseTrackSource(trackId, choice.id))} style={({ pressed }) => [s.pick, pressed && s.pressed]}>
        <Text style={s.title} numberOfLines={2}>{choice.title}</Text>
        <Text style={s.secondary} numberOfLines={1}>{sourceChoiceSummary(choice)}</Text>
      </Pressable>
      <Pressable accessibilityRole="link" accessibilityLabel={`Preview ${choice.title} on YouTube`} style={s.preview}
        onPress={() => void Linking.openURL(`https://www.youtube.com/watch?v=${choice.id}`)}>
        <Ionicons name="open-outline" size={18} color={colors.muted} />
      </Pressable>
    </View>) : <Text style={s.secondary}>No reviewable uploads were found for {title}.</Text> : null}
    {error ? <Notice title="Couldn't change the source" message={error} /> : null}
  </View>;
}

const s = StyleSheet.create({
  root: { gap: 8, paddingBottom: 12 },
  choice: { flexDirection: "row", alignItems: "center", gap: 8 },
  pick: { flex: 1, minHeight: 44, justifyContent: "center", gap: 2, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.elevated },
  pressed: { opacity: 0.7 }, preview: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { color: colors.text, fontSize: 15, fontWeight: "600" }, secondary: { color: colors.muted, fontSize: 14, lineHeight: 21 },
});
