import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Text } from "react-native";
import { collectionIdentity } from "@mint/client";
import { useApi } from "../../api";
import { CatalogCollectionRows, useCatalogCollection } from "../../components/music/CatalogCollectionSection";
import { CollectionDetail, detailStyles } from "../../components/music/CollectionDetail";
import { catalogAlbumItems } from "../../components/music/catalog-model";
import { MusicShelf } from "../../components/ui/music";
import { Section } from "../../components/ui/primitives";
import { useResource } from "../../hooks/useResource";
import { artistSelection, loadArtistDetail } from "./artist-model";

export function ArtistScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const api = useApi();
  const [start, setStart] = useState(0);
  const detail = useResource((signal) => loadArtistDetail(api, id, start, signal), [api, id, start]);
  const catalog = useCatalogCollection(id, detail.reload);
  const data = detail.data;
  const first = data?.page.items[0];
  const title = data?.page.title || collectionIdentity(id)?.artist || "Artist";
  const albums = [...(data?.albums.items ?? []), ...catalogAlbumItems(catalog.albums)];
  return <CollectionDetail detail={detail} selection={artistSelection(id)}
    title={title} artwork={first ? `/api/artwork/${first.id}?variant=artist` : undefined}
    round start={start} onStart={setStart} emptyTitle="Nothing imported yet"
    emptyMessage="This artist has no songs in the catalog yet."
    annotation={catalog.items.length ? ` · ${catalog.items.length} more not imported yet` : ""}
    hideEmpty={catalog.loading || !!catalog.error || catalog.items.length > 0}
    afterTracks={<CatalogCollectionRows catalog={catalog} albumFilter />}>
    {albums.length ? <Section title="Albums"><MusicShelf items={albums} /></Section> : null}
    {data?.page.artistProfile?.profile?.biography ? <Section title="About the artist">
      <Text style={detailStyles.secondary}>{data.page.artistProfile.profile.biography}</Text>
      <Text style={detailStyles.secondary}>Artist information from MusicBrainz and Wikipedia.</Text>
    </Section> : null}
  </CollectionDetail>;
}