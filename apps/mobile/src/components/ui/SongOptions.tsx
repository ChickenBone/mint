import { useState } from "react";
import type { PlayerItem } from "@mint/client";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../api";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors } from "../../theme/tokens";
import { Button, Notice } from "./primitives";

export function SongOptions({ item, remove }: { item: PlayerItem; remove?: () => Promise<void> }) {
  const api = useApi();
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<Awaited<ReturnType<NonNullable<typeof api>["collections"]>>["collections"] | null>(null);
  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The song action could not finish. Try again."); }
    finally { setBusy(false); }
  }
  async function choosePlaylist() {
    if (!api) return;
    await act(async () => { const result = await api.collections(); setPlaylists(result.collections.filter((collection) => !collection.rules)); }, "Choose a playlist below.");
  }
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Options for ${item.title}`} onPress={() => { setOpen(true); setError(null); setMessage(null); setPlaylists(null); }}
      style={s.trigger}><Ionicons name="ellipsis-horizontal" size={22} color={colors.muted} /></Pressable>
    <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
      <View style={s.overlay}><View accessibilityViewIsModal style={s.sheet}>
        <View style={s.header}><Text accessibilityRole="header" numberOfLines={2} style={s.title}>{item.title}</Text>
          <Button label="Close" quiet onPress={() => setOpen(false)} /></View>
        <ScrollView contentContainerStyle={s.actions}>
          <Button label="Add to queue" quiet busy={busy} onPress={() => void act(() => player.addToQueue(item), "Added to your queue.")} />
          <Button label="Like song" quiet disabled={!api || busy} onPress={() => api && void act(() => api.setLike(item.id, true), "Added to Liked songs.")} />
          <Button label="Remove like" quiet disabled={!api || busy} onPress={() => api && void act(() => api.setLike(item.id, false), "Removed from Liked songs.")} />
          <Button label="Add to playlist" quiet disabled={!api || busy} onPress={() => void choosePlaylist()} />
          <Button label="Download" quiet disabled={!player.capabilities.offline || busy} onPress={() => void act(() => player.download(item), "Download requested. Check its status in Settings.")} />
          {!player.capabilities.offline ? <Text style={s.secondary}>Offline downloads are not supported on this platform.</Text> : null}
          {remove ? <Button label="Remove from this playlist" quiet disabled={busy} onPress={() => void act(remove, "Removed from this playlist.")} /> : null}
          {playlists?.map((collection) => <Button key={collection.id} label={collection.title} quiet disabled={busy}
            onPress={() => api && void act(async () => {
              const latest = await api.collection(collection.id);
              await api.mutateCollection(collection.id, { action: "append", revision: latest.revision, trackIds: [item.id] });
            }, `Added to ${collection.title}.`)} />)}
          {playlists && !playlists.length ? <Notice title="No editable playlists" message="Create a playlist in Your Library first. Source-managed and smart playlists aren't edited here." /> : null}
          {error ? <Notice title="Couldn't finish" message={error} /> : message ? <Text accessibilityLiveRegion="polite" style={s.secondary}>{message}</Text> : null}
        </ScrollView>
      </View></View>
    </Modal>
  </>;
}

const s = StyleSheet.create({
  trigger: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  overlay: { flex: 1, backgroundColor: "#000000b3", justifyContent: "center", padding: 20 },
  sheet: { width: "100%", maxWidth: 480, maxHeight: "85%", alignSelf: "center", backgroundColor: colors.surface, borderRadius: 16, padding: 20 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 20 },
  title: { flex: 1, color: colors.text, fontSize: 22, fontWeight: "700" }, actions: { gap: 12, paddingBottom: 20 },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 22 },
});
