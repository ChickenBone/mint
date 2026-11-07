import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { useApi } from "../../api";
import { CollectionDetail } from "../../components/music/CollectionDetail";
import { useResource } from "../../hooks/useResource";
import { albumSelection, loadAlbumDetail } from "./album-model";

export function AlbumScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const api = useApi();
  const [start, setStart] = useState(0);
  const detail = useResource((signal) => loadAlbumDetail(api, id, start, signal), [api, id, start]);
  const first = detail.data?.page.items[0];
  return <CollectionDetail detail={detail} selection={albumSelection(id)}
    title={detail.data?.page.title ?? "Album"} artwork={first?.thumb} artistLink={first}
    start={start} onStart={setStart} />;
}
