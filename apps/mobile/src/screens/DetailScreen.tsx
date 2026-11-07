import { useState } from "react";
import type { PlayerCollection } from "@mint/client";
import { useLocalSearchParams, router } from "expo-router";
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useApi } from "../api";
import { Artwork, Button, Field, Notice, Section } from "../components/ui/primitives";
import { MusicShelf, TrackRow } from "../components/ui/music";
import { SongOptions } from "../components/ui/SongOptions";
import { useResource } from "../hooks/useResource";
import { usePlayer } from "../playback/PlayerProvider";
import { colors } from "../theme/tokens";
import { screenStyles } from "./HomeScreen";
import { reorderedEntries } from "./collection-model";
import { usePlaybackAction } from "../hooks/usePlaybackAction";

export function DetailScreen({ kind }: { kind: "album" | "artist" | "playlist" }) {
  const params = useLocalSearchParams<{ id: string; source?: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const api = useApi();
  const player = usePlayer();
  const runPlayback = usePlaybackAction();
  const { width } = useWindowDimensions();
  const [start, setStart] = useState(0);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingSongs, setEditingSongs] = useState(false);
  const selection: PlayerCollection = id === "liked" ? { kind: "native-liked", id: "" } :
    kind === "playlist" ? { kind: params.source === "spotify" ? "spotify" : "playlist", id } : { kind, id };
  const detail = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to load this music.");
    const [page, metadata, albums] = await Promise.all([
      api.catalog({ type: "track", kind: selection.kind, id: "id" in selection ? selection.id : undefined, size: 100, start }, signal),
      kind === "playlist" && id !== "liked" && params.source !== "spotify" ? api.collection(id, signal) : Promise.resolve(null),
      kind === "artist" ? api.catalog({ type: "album", kind: "artist", id, size: 20 }, signal) : Promise.resolve(null),
    ]);
    return { page, metadata, albums };
  }, [api, kind, id, params.source, start]);
  async function save() {
    if (!api || !detail.data?.metadata) return;
    setBusy(true); setError(null);
    try {
      await api.mutateCollection(id, { action: "update", revision: detail.data.metadata.revision, title: name.trim() });
      setEditing(false); detail.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The playlist could not be renamed."); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      const copy = await api.createCollection({ title: `${title.slice(0, 190)} (copy)`,
        ...(params.source === "spotify" ? { sourcePlaylistId: id } : { sourceCollectionId: id }) });
      router.replace({ pathname: "/collection/[id]", params: { id: copy.id } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "This playlist could not be copied."); }
    finally { setBusy(false); }
  }
  async function removePlaylist() {
    if (!api || !detail.data?.metadata) return;
    setBusy(true); setError(null);
    try {
      await api.mutateCollection(id, { action: "delete", revision: detail.data.metadata.revision });
      router.replace("/library");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "This playlist could not be deleted."); }
    finally { setBusy(false); setDeleting(false); }
  }
  async function moveEntry(entryId: string, direction: -1 | 1) {
    if (!api || !detail.data?.metadata) return;
    setBusy(true); setError(null);
    try {
      const metadata = detail.data.metadata;
      await api.mutateCollection(id, { action: "reorder", revision: metadata.revision,
        entryIds: reorderedEntries(metadata.entries.map((entry) => entry.entryId), entryId, direction) });
      detail.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "This song could not be moved."); }
    finally { setBusy(false); }
  }
  const data = detail.data;
  const title = id === "liked" ? "Liked songs" : data?.metadata?.title ?? data?.page.title ?? (kind === "album" ? "Album" : kind === "artist" ? "Artist" : "Playlist");
  const first = data?.page.items[0];
  const art = kind === "artist" ? first ? `/api/artwork/${first.id}?variant=artist` : undefined : data?.metadata?.artworkUrl || first?.thumb;
  const editable = data?.metadata && !data.metadata.rules;
  return <ScrollView contentContainerStyle={screenStyles.page} keyboardShouldPersistTaps="handled">
    {detail.loading ? <Notice loading title="Loading your music" /> : detail.error ? <Notice title="Couldn't load this music" message={detail.error} retry={detail.reload} /> : data ? <>
      <View style={[s.hero, width < 600 && s.heroPhone]}>
        <Artwork uri={art ? api?.artworkUrl(art) : undefined} size={width < 600 ? 200 : 224} round={kind === "artist"} liked={id === "liked"} />
        <View style={s.heroText}>
          <Text accessibilityRole="header" style={s.title}>{title}</Text>
          {kind === "album" && first?.artistId ? <Pressable accessibilityRole="link" accessibilityLabel={`Open artist ${first.artist}`}
            onPress={() => router.push({ pathname: "/artist/[id]", params: { id: first.artistId } })}><Text style={s.artist}>{first.artist}</Text></Pressable> : null}
          <Text style={s.secondary}>{data.page.total} {data.page.total === 1 ? "song" : "songs"}{params.source === "spotify" ? " · Source-managed import" : data.metadata?.rules ? " · Smart playlist" : ""}</Text>
          {data.metadata?.description ? <Text style={s.secondary}>{data.metadata.description}</Text> : null}
          <View style={screenStyles.shortcuts}><Button label="Play" icon="play" disabled={!data.page.total} onPress={() => runPlayback(() => player.playCollection(selection))} />
            <Button label="Shuffle" icon="shuffle" quiet disabled={!data.page.total} onPress={() => runPlayback(() => player.playCollection(selection, { shuffle: true }))} />
            {editable ? <Button label="Rename" quiet onPress={() => { setName(title); setEditing(!editing); }} /> : null}
            {editable ? <Button label={editingSongs ? "Done editing" : "Edit songs"} quiet onPress={() => setEditingSongs(!editingSongs)} /> : null}
            {kind === "playlist" && id !== "liked" ? <Button label="Make a copy" quiet busy={busy} onPress={() => void copy()} /> : null}
            {data.metadata?.role === "owner" ? <Button label="Delete playlist" quiet disabled={busy} onPress={() => setDeleting(true)} /> : null}
          </View>
        </View>
      </View>
      {editing ? <View style={s.edit}><Field label="Playlist name" value={name} maxLength={200} onChangeText={setName} />
        <View style={screenStyles.shortcuts}><Button label="Save" busy={busy} disabled={!name.trim()} onPress={() => void save()} />
          <Button label="Cancel" quiet onPress={() => setEditing(false)} /></View></View> : null}
      {error ? <Notice title="Couldn't update playlist" message={error} /> : null}
      {!data.page.items.length ? <Notice title={id === "liked" ? "Your favorites start here" : "No songs yet"}
        message={id === "liked" ? "Use a song's options to like it." : editable ? "Add songs using their Add to playlist action." : "There are no playable songs in this selection."} /> : null}
      {data.page.items.map((item) => {
        const metadata = data.metadata;
        const entry = metadata?.entries.find((candidate) => candidate.entryId === item.occurrenceId);
        const position = entry && metadata ? metadata.entries.indexOf(entry) : -1;
        return <View key={item.occurrenceId ?? item.id}><TrackRow item={item} onPress={() => runPlayback(() => player.playCollection(selection, { id: item.id, occurrenceId: item.occurrenceId }))}
          trailing={<SongOptions item={item} remove={editable && entry ? async () => {
            if (!api || !data.metadata) throw new Error("Reload this playlist.");
            await api.mutateCollection(id, { action: "remove", revision: data.metadata.revision, entryId: entry.entryId }); detail.reload();
          } : undefined} />} />
          {editingSongs && editable && entry ? <View style={screenStyles.shortcuts}>
            <Button label={`Move ${item.title} up`} quiet disabled={busy || position <= 0} onPress={() => void moveEntry(entry.entryId, -1)} />
            <Button label={`Move ${item.title} down`} quiet disabled={busy || !metadata || position >= metadata.entries.length - 1} onPress={() => void moveEntry(entry.entryId, 1)} />
          </View> : null}
        </View>;
      })}
      {data.page.total > 100 ? <View style={[screenStyles.shortcuts, { marginTop: 24 }]}>
        <Button label="Previous songs" quiet disabled={!start} onPress={() => setStart(Math.max(0, start - 100))} />
        <Button label="Next songs" quiet disabled={start + data.page.items.length >= data.page.total} onPress={() => setStart(start + 100)} />
        <Text style={s.secondary}>{start + 1}–{start + data.page.items.length} of {data.page.total}</Text>
      </View> : null}
      {data.albums?.items.length ? <Section title="Albums"><MusicShelf items={data.albums.items} /></Section> : null}
      {data.page.artistProfile?.profile?.biography ? <Section title="About the artist">
        <Text style={s.secondary}>{data.page.artistProfile.profile.biography}</Text>
        <Text style={s.secondary}>Artist information from MusicBrainz and Wikipedia.</Text>
      </Section> : null}
      <Modal visible={deleting} transparent animationType="none" onRequestClose={() => { if (!busy) setDeleting(false); }}>
        <View style={s.overlay}><View accessibilityViewIsModal style={s.dialog}>
          <Text accessibilityRole="header" style={s.dialogTitle}>Delete this playlist?</Text>
          <Text style={s.secondary}>This removes the playlist for you and its collaborators. Songs in your server library are not deleted.</Text>
          <View style={screenStyles.shortcuts}><Button label="Delete playlist" busy={busy} onPress={() => void removePlaylist()} />
            <Button label="Cancel" quiet disabled={busy} onPress={() => setDeleting(false)} /></View>
        </View></View>
      </Modal>
    </> : null}
  </ScrollView>;
}

const s = StyleSheet.create({
  hero: { flexDirection: "row", alignItems: "flex-end", gap: 24, marginTop: 8, marginBottom: 24 },
  heroPhone: { flexDirection: "column", alignItems: "center" }, heroText: { flex: 1, width: "100%", gap: 14 },
  title: { color: colors.text, fontSize: 38, fontWeight: "800", letterSpacing: -.8 }, artist: { color: colors.text, fontSize: 16, fontWeight: "600", textDecorationLine: "underline" },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 23 }, edit: { gap: 12, maxWidth: 440, marginBottom: 24 },
  overlay: { flex: 1, backgroundColor: "#000000b3", justifyContent: "center", padding: 24 },
  dialog: { width: "100%", maxWidth: 440, alignSelf: "center", padding: 24, backgroundColor: colors.surface, borderRadius: 16, gap: 20 },
  dialogTitle: { color: colors.text, fontSize: 24, fontWeight: "700" },
});
