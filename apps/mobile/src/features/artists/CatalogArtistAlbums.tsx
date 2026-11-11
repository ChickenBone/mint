import { externalCatalogPageSchema } from "@mint/client";
import { router } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { useApi } from "../../api";
import { detailStyles } from "../../components/music/CollectionDetail";
import { Button, Notice, Section } from "../../components/ui/primitives";
import { useResource } from "../../hooks/useResource";

export function CatalogArtistAlbums({ artistMbid }: { artistMbid: string }) {
  const api = useApi();
  const [after, setAfter] = useState<string | null>(null);
  const resource = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to browse the catalog.");
    const params = new URLSearchParams({ limit: "50" });
    if (after) params.set("after", after);
    return api.request(`catalog/artists/${artistMbid}/albums?${params}`, externalCatalogPageSchema, { signal });
  }, [api, artistMbid, after]);
  if (resource.data?.configured === false) return null;
  return <Section title="Beyond your library">
    <Text style={detailStyles.secondary}>Catalog albums from MusicBrainz. Browsing does not add or download music.</Text>
    {resource.loading ? <Notice loading title="Loading catalog albums" /> : resource.error ?
      <Notice title="Catalog albums unavailable" message={resource.error} retry={resource.reload} /> : null}
    {resource.data?.items.map((album) => <View key={album.id} style={{ gap: 8 }}>
      <Text style={detailStyles.secondary}>{album.title} - {album.artist}</Text>
      <Button quiet label={`Browse ${album.title}`} onPress={() => router.push({
        pathname: "/album/[id]", params: { id: `mbal_${album.id}`, title: album.title, artist: album.artist },
      })} />
    </View>)}
    {resource.data?.configured && !resource.data.items.length ? <Text style={detailStyles.secondary}>No catalog albums populated yet.</Text> : null}
    {after ? <Button quiet label="First catalog page" onPress={() => setAfter(null)} /> : null}
    {resource.data?.nextCursor ? <Button quiet label="More catalog albums" onPress={() => setAfter(resource.data!.nextCursor)} /> : null}
  </Section>;
}
