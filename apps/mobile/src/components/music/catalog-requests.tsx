import { useState } from "react";
import type { MintApi, RecordingSearchItem } from "@mint/client";
import Ionicons from "@expo/vector-icons/Ionicons";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { songLikes } from "../../hooks/song-likes";
import { colors } from "../../theme/tokens";
import type { CatalogRequest } from "./catalog-model";

export type { CatalogRequest } from "./catalog-model";
type RequestInput = { token: string; searchRequestId?: string };

/** Shared like-and-import / import-only state for catalog songs that are not in the library yet. */
export function useCatalogRequests(api: MintApi | null) {
  const [requested, setRequested] = useState<ReadonlyMap<string, CatalogRequest>>(new Map());
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function request(recording: RecordingSearchItem, like: boolean, input: RequestInput = { token: recording.token }) {
    if (!api) return null;
    setPending(recording.id); setError(null);
    try {
      const result = await api.requestRecording({ ...input, ...(like ? { like: true } : {}) });
      const previous = requested.get(recording.id);
      setRequested((current) => new Map(current).set(recording.id, { trackId: result.trackId, stage: result.stage, liked: like || !!previous?.liked }));
      if (like) songLikes(api).markLiked(result.trackId);
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This song could not be added. Try again.");
      return null;
    } finally { setPending(null); }
  }
  const stages = new Map([...requested].map(([id, value]) => [id, value.stage]));
  return { requested, stages, pending, error, request };
}

/** Heart likes the song and starts its import; the options button offers importing without liking. */
export function CatalogRecordingActions({ recording, state, busy, disabled, onLike, onImport }: {
  recording: RecordingSearchItem; state?: CatalogRequest; busy: boolean; disabled: boolean;
  onLike: () => void; onImport: () => void;
}) {
  const name = `${recording.title} by ${recording.artist}`;
  const liked = !!state?.liked;
  const imported = !!state || (!!recording.existing && recording.existing.stage !== "failed");
  const openOptions = () => {
    if (Platform.OS === "web") {
      if (globalThis.confirm(`Import “${recording.title}” without liking it?`)) onImport();
      return;
    }
    Alert.alert(recording.title, recording.artist, [
      { text: "Import without liking", onPress: onImport },
      { text: "Cancel", style: "cancel" },
    ]);
  };
  return <View style={s.actions}>
    <Pressable accessibilityRole="button" accessibilityLabel={liked ? `Liked ${name}` : `Like and import ${name}`}
      accessibilityState={{ disabled: disabled || liked || busy, busy, selected: liked }} disabled={disabled || liked || busy}
      onPress={onLike} hitSlop={4} style={({ pressed }) => [s.icon, pressed && s.pressed]}>
      {busy ? <ActivityIndicator color={colors.text} /> :
        <Ionicons name={liked ? "heart" : "heart-outline"} size={24} color={liked ? colors.action : colors.text} />}
    </Pressable>
    {!imported ? <Pressable accessibilityRole="button" accessibilityLabel={`More options for ${name}`}
      accessibilityHint="Import without adding to Liked songs" accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy} onPress={openOptions} hitSlop={4} style={({ pressed }) => [s.icon, (disabled || busy) && s.disabled, pressed && s.pressed]}>
      <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
    </Pressable> : null}
  </View>;
}

const s = StyleSheet.create({
  actions: { flexDirection: "row", alignItems: "center", gap: 4 },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: .6 }, disabled: { opacity: .45 },
});
