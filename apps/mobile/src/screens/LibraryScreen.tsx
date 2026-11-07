import { useState } from "react";
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../api";
import { Artwork, Button, Field, Notice, Section } from "../components/ui/primitives";
import { MusicCard, TrackRow } from "../components/ui/music";
import { PageTitle } from "../components/ui/PageTitle";
import { SongOptions } from "../components/ui/SongOptions";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useResource } from "../hooks/useResource";
import { colors } from "../theme/tokens";
import { screenStyles } from "./HomeScreen";

export function LibraryScreen() {
  const api = useApi();
  const [filter, setFilter] = useState<"playlist" | "album" | "artist" | "track">("playlist");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("all");
  const [start, setStart] = useState(0);
  const library = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to load your library.");
    const [native, catalog] = await Promise.all([api.collections(signal), api.catalog({ type: filter, size: 100, start }, signal)]);
    return { native, catalog };
  }, [api, filter, start]);
  async function create() {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      const result = await api.createCollection({ title: title.trim() });
      setCreating(false); setTitle(""); library.reload();
      router.push({ pathname: "/collection/[id]", params: { id: result.id } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The playlist could not be created."); }
    finally { setBusy(false); }
  }
  async function update(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); library.reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Your library could not be updated."); }
    finally { setBusy(false); }
  }
  return <ScrollView contentContainerStyle={screenStyles.page} keyboardShouldPersistTaps="handled">
    <PageTitle title="Your Library" />
    <View style={screenStyles.shortcuts}>
      {(["playlist", "album", "artist", "track"] as const).map((kind) => <Pressable key={kind} accessibilityRole="button"
        accessibilityState={{ selected: kind === filter }} onPress={() => { setFilter(kind); setStart(0); }} style={[s.filter, filter === kind && s.activeFilter]}>
        <Text style={[s.filterText, filter === kind && { color: colors.actionInk }]}>{kind === "playlist" ? "Playlists" : kind === "album" ? "Albums" : kind === "artist" ? "Artists" : "Songs"}</Text>
      </Pressable>)}
    </View>
    {filter === "playlist" ? <>
      <Section title="Made yours">
        <Pressable accessibilityRole="button" accessibilityLabel="Open Liked songs" onPress={() => router.push("/collection/liked")} style={s.collection}>
          <Artwork liked size={64} /><View style={s.collectionText}><Text style={s.title}>Liked songs</Text><Text style={s.subtitle}>Your favorites, all together</Text></View>
        </Pressable>
        <Button label="Create playlist" quiet icon="add" onPress={() => setCreating(!creating)} />
        {creating ? <View style={s.create}><Field label="Playlist name" value={title} onChangeText={setTitle} maxLength={200} onSubmitEditing={() => void create()} />
          <View style={screenStyles.shortcuts}><Button label="Create" onPress={() => void create()} busy={busy} disabled={!title.trim()} />
            <Button label="Cancel" quiet onPress={() => setCreating(false)} /></View></View> : null}
      </Section>
    </> : null}
    {library.loading ? <Notice loading title="Loading your library" /> : library.error ? <Notice title="Couldn't load your library" message={library.error} retry={library.reload} /> : library.data ? <>
      {filter === "playlist" && library.data.native.invitations.length ? <Section title="Playlist invitations">
        {library.data.native.invitations.map((invitation) => <View key={invitation.id} style={s.invitation}>
          <View style={s.collectionText}><Text style={s.title}>{invitation.title}</Text><Text style={s.subtitle}>Invited by {invitation.owner}</Text></View>
          <Button label="Accept" quiet disabled={busy} onPress={() => api && void update(() => api.respondInvitation(invitation.id, true))} />
          <Button label="Decline" quiet disabled={busy} onPress={() => api && void update(() => api.respondInvitation(invitation.id, false))} />
        </View>)}
      </Section> : null}
      {filter === "playlist" ? <Section title="Playlists">
        {library.data.native.folders.length ? <ScrollView horizontal contentContainerStyle={{ gap: 8 }} showsHorizontalScrollIndicator={false}>
          <Button label="All playlists" quiet={folder !== "all"} onPress={() => setFolder("all")} />
          {library.data.native.folders.map((item) => <Button key={item.id} label={item.title} quiet={folder !== item.id} onPress={() => setFolder(item.id)} />)}
        </ScrollView> : null}
        {library.data.native.collections.filter((collection) => folder === "all" || collection.folderId === folder).map((collection) => <View key={collection.id} style={s.playlistRow}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Open ${collection.title}`}
          onPress={() => router.push({ pathname: "/collection/[id]", params: { id: collection.id } })} style={[s.collection, { flex: 1 }]}>
          <Artwork uri={collection.artworkUrl ? api?.artworkUrl(collection.artworkUrl) : undefined} size={64} />
          <View style={s.collectionText}><Text numberOfLines={1} style={s.title}>{collection.title}</Text><Text style={s.subtitle}>{collection.rules ? "Smart playlist" : collection.role === "editor" ? "Collaborative playlist" : "Playlist"}{collection.pinned ? " · Pinned" : ""}</Text></View>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`${collection.pinned ? "Unpin" : "Pin"} ${collection.title}`} disabled={busy} style={s.pin}
            onPress={() => api && void update(() => api.organizeCollection(collection.id, { pinned: !collection.pinned, folderId: collection.folderId }))}>
            <Ionicons name={collection.pinned ? "bookmark" : "bookmark-outline"} size={22} color={collection.pinned ? colors.action : colors.muted} />
          </Pressable>
        </View>)}
        {folder === "all" ? library.data.catalog.items.filter((item) => item.playlistSource === "spotify").map((item) => <Pressable key={item.id} style={s.collection}
          accessibilityRole="button" accessibilityLabel={`Open imported playlist ${item.title}`} onPress={() => router.push({ pathname: "/collection/[id]", params: { id: item.id, source: "spotify" } })}>
          <Artwork uri={item.thumb ? api?.artworkUrl(item.thumb) : undefined} size={64} /><View style={s.collectionText}><Text style={s.title}>{item.title}</Text><Text style={s.subtitle}>Imported playlist · Source-managed</Text></View>
        </Pressable>) : null}
        {folder !== "all" && !library.data.native.collections.some((collection) => collection.folderId === folder) ? <Notice title="No playlists in this folder" message="Choose All playlists to see your other collections." /> : null}
        {!library.data.native.collections.length && !library.data.catalog.items.some((item) => item.playlistSource === "spotify") ? <Notice title="A playlist for every mood" message="Create a playlist, then add songs from their song options." /> : null}
      </Section> : <Section title={filter === "track" ? "Songs" : filter === "album" ? "Albums" : "Artists"}>
        {filter === "track" ? library.data.catalog.items.map((item) => <TrackRow key={item.id} item={item} trailing={<SongOptions item={item} />} />) :
          <View style={s.grid}>{library.data.catalog.items.map((item) => <MusicCard key={item.id} item={item} />)}</View>}
        {!library.data.catalog.items.length ? <Notice title="Nothing here yet" message="Find music in Search to start listening." /> : null}
      </Section>}
      {library.data.catalog.total > 100 ? <View style={[screenStyles.shortcuts, { marginTop: 24 }]}>
        <Button label="Previous page" quiet disabled={!start} onPress={() => setStart(Math.max(0, start - 100))} />
        <Button label="Next page" quiet disabled={start + library.data.catalog.items.length >= library.data.catalog.total} onPress={() => setStart(start + 100)} />
        <Text style={s.subtitle}>{start + 1}–{start + library.data.catalog.items.length} of {library.data.catalog.total}</Text>
      </View> : null}
    </> : null}
    {error ? <Notice title="Couldn't update your library" message={error} /> : null}
  </ScrollView>;
}

const s = StyleSheet.create({
  filter: { minHeight: 44, paddingHorizontal: 16, justifyContent: "center", borderRadius: 24, backgroundColor: colors.elevated },
  activeFilter: { backgroundColor: colors.action }, filterText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  collection: { flexDirection: "row", alignItems: "center", gap: 16, minHeight: 80, paddingVertical: 8 },
  collectionText: { flex: 1, minWidth: 0, gap: 6 }, title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 21 }, grid: { flexDirection: "row", flexWrap: "wrap", gap: 24 },
  create: { gap: 12, maxWidth: 440 },
  invitation: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 },
  playlistRow: { flexDirection: "row", alignItems: "center" },
  pin: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
