import { externalCatalogPageSchema } from "@mint/client";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { useApi } from "../../api";
import { detailStyles } from "../../components/music/CollectionDetail";
import { MusicCard, musicStyles } from "../../components/ui/music";
import { Artwork, Button, Notice, Section } from "../../components/ui/primitives";
import { useResource } from "../../hooks/useResource";
import { groupArtistAlbums, type ArtistAlbum } from "./artist-model";

function openCatalogAlbum(album: { id: string; title: string; artist: string }, bridge: boolean) {
  router.push({ pathname: "/album/[id]", params: { id: bridge ? `mbal_${album.id}` : album.id, title: album.title, artist: album.artist } });
}

export function CatalogArtistAlbums({ artistMbid, albums, waiting }: {
  artistMbid: string | null; albums: ArtistAlbum[]; waiting: boolean;
}) {
  const api = useApi();
  const [after, setAfter] = useState<string | null>(null);
  const resource = useResource(async (signal) => {
    if (!artistMbid) return null;
    if (!api) throw new Error("Sign in to browse the catalog.");
    const params = new URLSearchParams({ limit: "50" });
    if (after) params.set("after", after);
    return api.request(`catalog/artists/${artistMbid}/albums?${params}`, externalCatalogPageSchema, { signal });
  }, [api, artistMbid, after]);
  const loading = !!artistMbid && resource.loading;
  const entries = groupArtistAlbums(albums, resource.data?.items ?? []);
  const occurrences = new Map<string, number>();
  const cards = entries.map((entry) => {
    const id = entry.source === "library" ? entry.item.id : entry.album.id;
    const base = `${entry.source}:${id}`;
    const index = occurrences.get(base) ?? 0;
    occurrences.set(base, index + 1);
    return { entry, key: `${base}:${index}` };
  });
  return <Section title="Albums">
    {entries.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={musicStyles.rail}>
      {cards.map(({ entry, key }) => entry.source === "library" ?
        <MusicCard key={key} item={entry.item} /> :
        <Pressable key={key} accessibilityRole="button"
        accessibilityLabel={`Browse ${entry.source === "bridge" ? "MusicBrainz " : ""}catalog album ${entry.album.title} by ${entry.album.artist}`}
        onPress={() => openCatalogAlbum(entry.album, entry.source === "bridge")}
        style={({ pressed }) => [musicStyles.card, pressed && { opacity: .75 }]}>
        <Artwork size={152} />
        <Text numberOfLines={2} style={musicStyles.title}>{entry.album.title}</Text>
        <Text numberOfLines={2} style={musicStyles.subtitle}>{entry.source === "bridge" ? "MusicBrainz" : "Catalog"} album · {entry.album.artist}</Text>
      </Pressable>)}
    </ScrollView> : null}
    {resource.data?.configured && resource.data.items.length ?
      <Text style={detailStyles.secondary}>Catalog albums are metadata; browsing does not add or download music.</Text> : null}
    {loading ? <Notice loading title="Loading catalog albums" /> : resource.error ?
      <Notice title="Catalog albums unavailable" message={resource.error} retry={resource.reload} /> : null}
    {!entries.length && !loading && !resource.error && !waiting ?
      <Notice title="No albums yet" message="No library or catalog albums are available here yet." /> : null}
    {after ? <Button quiet label="First catalog page" onPress={() => setAfter(null)} /> : null}
    {resource.data?.nextCursor ? <Button quiet label="More catalog albums" onPress={() => setAfter(resource.data!.nextCursor)} /> : null}
  </Section>;
}
