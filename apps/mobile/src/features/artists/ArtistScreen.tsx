import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Text } from "react-native";
import { useApi } from "../../api";
import { CollectionDetail, detailStyles } from "../../components/music/CollectionDetail";
import { MusicShelf } from "../../components/ui/music";
import { Section } from "../../components/ui/primitives";
import { useResource } from "../../hooks/useResource";
import { artistSelection, loadArtistDetail } from "./artist-model";
import { CatalogArtistAlbums } from "./CatalogArtistAlbums";

export function ArtistScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const api = useApi();
  const [start, setStart] = useState(0);
  const detail = useResource((signal) => loadArtistDetail(api, id, start, signal), [api, id, start]);
  const data = detail.data;
  const first = data?.page.items[0];
  return <CollectionDetail detail={detail} selection={artistSelection(id)}
    title={data?.page.title ?? "Artist"} artwork={first ? `/api/artwork/${first.id}?variant=artist` : undefined}
    round start={start} onStart={setStart}>
    {data?.albums.items.length ? <Section title="Albums"><MusicShelf items={data.albums.items} /></Section> : null}
    {data?.albums.artistProfile?.status === "ready" && data.albums.artistProfile.musicBrainzArtistId ?
      <CatalogArtistAlbums key={data.albums.artistProfile.musicBrainzArtistId} artistMbid={data.albums.artistProfile.musicBrainzArtistId} /> : null}
    {data?.page.artistProfile?.profile?.biography ? <Section title="About the artist">
      <Text style={detailStyles.secondary}>{data.page.artistProfile.profile.biography}</Text>
      <Text style={detailStyles.secondary}>Artist information from MusicBrainz and Wikipedia.</Text>
    </Section> : null}
  </CollectionDetail>;
}
