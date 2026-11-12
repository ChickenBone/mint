import { useEffect, useRef, useState } from "react";
import type { TrackView } from "@mint/client";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useApi } from "../../api";
import { useResource } from "../../hooks/useResource";
import { useLikesRevision } from "../../hooks/useSongLike";
import { colors } from "../../theme/tokens";
import { Section } from "../../components/ui/primitives";
import { likedImportStatus } from "./playlist-model";
import { SourcePicker } from "./SourcePicker";

const playable = new Set(["ready", "analyzing"]);

/** Liked songs that are still importing; playable likes stay in the main list. */
export function LikedImports({ onReady }: { onReady?: () => void }) {
  const api = useApi();
  const revision = useLikesRevision(api);
  const likes = useResource(async (signal) => {
    if (!api) return [];
    return (await api.likes(signal)).tracks.map(({ track }) => track).filter((track) => !playable.has(track.stage));
  }, [api, revision]);
  const [last, setLast] = useState<TrackView[] | null>(null);
  if (likes.data && likes.data !== last) setLast(likes.data);
  const items = likes.data ?? last ?? [];
  const { reload } = likes;
  const active = items.some((track) => track.stage !== "failed");
  const pendingKey = items.filter((track) => track.stage !== "failed").map((track) => track.id).join(",");
  const previous = useRef(pendingKey);
  useEffect(() => {
    const before = previous.current.split(",").filter(Boolean);
    previous.current = pendingKey;
    if (likes.data && before.some((id) => !pendingKey.split(",").includes(id))) onReady?.();
  }, [pendingKey, likes.data, onReady]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, 5_000);
    return () => clearInterval(timer);
  }, [active, reload]);
  if (!items.length) return null;
  return <Section title="Importing">
    {items.map((track) => <View key={track.id}><View style={s.row} accessible
      accessibilityLabel={`${track.title} by ${track.artist}, ${likedImportStatus(track)}`}>
      <View style={s.metadata}>
        <Text style={s.title} numberOfLines={2}>{track.title}</Text>
        <Text style={s.secondary} numberOfLines={1}>{track.artist}{track.album ? ` · ${track.album}` : ""}</Text>
      </View>
      <View style={s.status}>
        {track.stage === "failed" ? <Ionicons name="alert-circle-outline" size={18} color={colors.muted} />
          : <ActivityIndicator size="small" color={colors.muted} />}
        <Text accessibilityLiveRegion="polite" style={s.secondary}>{likedImportStatus(track)}</Text>
      </View>
    </View>
    {track.stage === "failed" && track.detail === "Needs a source" ? <SourcePicker trackId={track.id} title={track.title} onChosen={reload} /> : null}
    </View>)}
  </Section>;
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.elevated },
  metadata: { flex: 1, gap: 4 }, title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  status: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "45%" },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 21 },
});
