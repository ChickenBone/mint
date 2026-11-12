import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { collectionIdentity } from "@mint/client";
import { useApi } from "../../api";
import { CatalogCollectionRows, useCatalogCollection } from "../../components/music/CatalogCollectionSection";
import { CollectionDetail } from "../../components/music/CollectionDetail";
import { useResource } from "../../hooks/useResource";
import { albumSelection, loadAlbumDetail } from "./album-model";

export function AlbumScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const api = useApi();
  const [start, setStart] = useState(0);
  const detail = useResource((signal) => loadAlbumDetail(api, id, start, signal), [api, id, start]);
  const catalog = useCatalogCollection(id, detail.reload);
  const first = detail.data?.page.items[0];
  const title = detail.data?.page.title || collectionIdentity(id)?.album || "Album";
  return <CollectionDetail detail={detail} selection={albumSelection(id)}
    title={title} artwork={first?.thumb} artistLink={first}
    start={start} onStart={setStart} emptyTitle="Nothing imported yet"
    emptyMessage="This album has no songs in the catalog yet."
    annotation={catalog.items.length ? ` · ${catalog.items.length} more not imported yet` : ""}
    hideEmpty={catalog.loading || !!catalog.error || catalog.items.length > 0}
    afterTracks={<CatalogCollectionRows catalog={catalog} />} />;
}