import { useEffect, useState } from "react";
import type { CatalogCollectionResponse } from "@mint/client";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../api";
import { useResource } from "../../hooks/useResource";
import { colors } from "../../theme/tokens";
import { Button, Notice } from "../ui/primitives";
import { catalogRequestLabel, catalogSongAlbums, filterCatalogSongs, finishedImportStages as finished } from "./catalog-model";
import { CatalogRecordingActions, useCatalogRequests } from "./catalog-requests";

/** Catalog songs and correlated albums for an artist or album page that are not playable in the library yet. */
export function useCatalogCollection(id: string, onImported?: () => void) {
  const api = useApi();
  const requests = useCatalogRequests(api);
  const songs = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to browse the catalog.");
    return api.collectionRecordings(id, signal);
  }, [api, id]);
  // Keep the previous answer on screen while a status refresh is in flight.
  const [last, setLast] = useState<{ id: string; data: CatalogCollectionResponse } | null>(null);
  if (songs.data && last?.data !== songs.data) setLast({ id, data: songs.data });
  const data = songs.data ?? (last?.id === id ? last.data : null);
  const items = data?.items ?? [];
  const { reload } = songs;
  const pending = [...requests.requested.entries()].some(([recordingId, request]) => {
    const recording = items.find((item) => item.id === recordingId);
    return !finished.has(recording?.existing?.stage ?? request.stage);
  });
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => { reload(); onImported?.(); }, 10_000);
    return () => clearInterval(timer);
  }, [pending, reload, onImported]);
  return { data, items, albums: data?.albums ?? [], error: data ? null : songs.error, loading: !data && !songs.error,
    reload: () => { reload(); onImported?.(); }, requests };
}

export type CatalogCollection = ReturnType<typeof useCatalogCollection>;

/** Not-yet-imported catalog songs continuing the page's song list, filterable by correlated album. */
export function CatalogCollectionRows({ catalog, albumFilter = false }: { catalog: CatalogCollection; albumFilter?: boolean }) {
  const [album, setAlbum] = useState<string | null>(null);
  const { requests } = catalog;
  if (catalog.loading) return <Notice loading title="Looking for more songs" />;
  if (catalog.error) return <Notice title="More songs couldn't load" message={catalog.error} retry={catalog.reload} />;
  if (!catalog.items.length) return null;
  const albums = albumFilter ? catalogSongAlbums(catalog.items) : [];
  const items = filterCatalogSongs(catalog.items, albums.includes(album ?? "") ? album : null);
  return <View accessibilityLabel="Songs not imported yet">
    {albums.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
      {[null, ...albums].map((value) => {
        const selected = (albums.includes(album ?? "") ? album : null) === value;
        return <Pressable key={value ?? "all"} accessibilityRole="button" accessibilityState={{ selected }}
          accessibilityLabel={value ? `Show songs not imported yet from ${value}` : "Show all songs not imported yet"}
          onPress={() => setAlbum(value)} style={[s.chip, selected && s.chipActive]}>
          <Text numberOfLines={1} style={[s.chipText, selected && { color: colors.actionInk }]}>{value ?? "All songs"}</Text>
        </Pressable>;
      })}
    </ScrollView> : null}
    {items.map((recording) => {
      const state = requests.requested.get(recording.id);
      return <View key={recording.id} style={s.row}>
        <View style={s.metadata}>
          <Text style={s.title} numberOfLines={2}>{recording.title}</Text>
          <Text style={s.secondary} numberOfLines={1}>{recording.artist}{recording.album ? ` · ${recording.album}` : ""}</Text>
          <Text accessibilityLiveRegion="polite" style={s.secondary}>{catalogRequestLabel(recording, state)}</Text>
        </View>
        <CatalogRecordingActions recording={recording} state={state} busy={requests.pending === recording.id}
          disabled={requests.pending !== null} onLike={() => void requests.request(recording, true)}
          onImport={() => void requests.request(recording, false)} />
      </View>;
    })}
    {requests.error ? <Notice title="Couldn't add this song" message={requests.error} /> : null}
    {requests.requested.size ? <Button label="Refresh" quiet onPress={catalog.reload} /> : null}
  </View>;
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.elevated },
  metadata: { flex: 1, gap: 4 }, title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  chips: { gap: 8, paddingVertical: 12 },
  chip: { minHeight: 44, maxWidth: 240, justifyContent: "center", paddingHorizontal: 16, borderRadius: 22, backgroundColor: colors.elevated },
  chipActive: { backgroundColor: colors.action }, chipText: { color: colors.text, fontSize: 14, fontWeight: "600" },
});
