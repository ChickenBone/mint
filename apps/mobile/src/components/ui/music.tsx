import type { PlayerItem } from "@mint/client";
import { router } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../api";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors } from "../../theme/tokens";
import { Artwork } from "./primitives";
import { usePlaybackAction } from "../../hooks/usePlaybackAction";

export function openItem(item: PlayerItem) {
  if (item.type === "album") router.push({ pathname: "/album/[id]", params: { id: item.id } });
  else if (item.type === "artist") router.push({ pathname: "/artist/[id]", params: { id: item.id } });
  else if (item.type === "playlist") router.push({ pathname: "/collection/[id]", params: { id: item.id } });
}

export function MusicCard({ item }: { item: PlayerItem }) {
  const api = useApi();
  const player = usePlayer();
  const run = usePlaybackAction();
  return <Pressable accessibilityRole="button" accessibilityLabel={`${item.type === "track" ? "Play" : "Open"} ${item.title}`}
    onPress={() => item.type === "track" ? run(() => player.playTrack(item)) : openItem(item)} style={({ pressed }) => [s.card, pressed && { opacity: .75 }]}>
    <Artwork uri={item.thumb ? api?.artworkUrl(item.thumb) : undefined} size={152} round={item.type === "artist"} />
    <Text numberOfLines={2} style={s.title}>{item.title}</Text>
    <Text numberOfLines={2} style={s.subtitle}>{item.artist || (item.type === "artist" ? "Artist" : item.type === "playlist" ? "Playlist" : "Album")}</Text>
  </Pressable>;
}

export function MusicShelf({ items }: { items: PlayerItem[] }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rail}>
    {items.map((item) => <MusicCard key={`${item.type}:${item.id}`} item={item} />)}
  </ScrollView>;
}

export function TrackRow({ item, onPress, trailing, subtitle }: { item: PlayerItem; onPress?: () => void; trailing?: React.ReactNode; subtitle?: string }) {
  const api = useApi();
  const player = usePlayer();
  const run = usePlaybackAction();
  const selected = player.state.track?.id === item.id;
  return <View style={s.row}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Play ${item.title} by ${item.artist ?? "unknown artist"}`}
      onPress={onPress ?? (() => run(() => player.playTrack(item)))} style={({ pressed }) => [s.song, pressed && { opacity: .75 }]}>
      <Artwork uri={item.thumb ? api?.artworkUrl(item.thumb) : undefined} size={52} />
      <View style={s.metadata}><Text numberOfLines={1} style={[s.title, selected && { color: colors.action }]}>{item.title}</Text>
        <Text numberOfLines={1} style={s.subtitle}>{subtitle ?? item.artist ?? "Unknown artist"}</Text></View>
      {selected && player.state.playing ? <Ionicons name="volume-high" size={18} color={colors.action} /> : null}
    </Pressable>
    {trailing}
  </View>;
}

const s = StyleSheet.create({
  card: { width: 152, gap: 8 }, rail: { gap: 16, paddingBottom: 4 },
  title: { color: colors.text, fontSize: 16, fontWeight: "600", lineHeight: 22 },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 72, gap: 8 },
  song: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  metadata: { flex: 1, minWidth: 0, gap: 4 },
});
export const musicStyles = s;
