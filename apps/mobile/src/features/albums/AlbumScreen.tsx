import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { useApi } from "../../api";
import { CollectionDetail } from "../../components/music/CollectionDetail";
import { useResource } from "../../hooks/useResource";
import { albumSelection, loadAlbumDetail } from "./album-model";
import { CatalogAlbumScreen, CatalogAlbumRecordings } from "./CatalogAlbumScreen";

export function AlbumScreen() {
  const params = useLocalSearchParams<{ id: string; title?: string; artist?: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  if (/^mbal_[0-9a-f-]{36}$/.test(id)) return <CatalogAlbumScreen key={id} id={id.slice(5)}
    title={typeof params.title === "string" ? params.title : "Catalog album"}
    artist={typeof params.artist === "string" ? params.artist : "MusicBrainz"} />;
  return <LibraryAlbumScreen key={id} id={id} />;
}

function LibraryAlbumScreen({ id }: { id: string }) {
  const api = useApi();
  const [start, setStart] = useState(0);
  const detail = useResource((signal) => loadAlbumDetail(api, id, start, signal), [api, id, start]);
  const first = detail.data?.page.items[0];
  return <CollectionDetail detail={detail} selection={albumSelection(id)}
    title={detail.data?.page.title ?? "Album"} artwork={first?.thumb} artistLink={first}
    start={start} onStart={setStart}>
    <CatalogAlbumRecordings key={id} id={id} local />
  </CollectionDetail>;
}
