import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { collectionIdentity } from "@mint/client";
import { useApi } from "../../api";
import { useAuth } from "../../auth";
import { CatalogCollectionRows, useCatalogCollection } from "../../components/music/CatalogCollectionSection";
import { CollectionDetail } from "../../components/music/CollectionDetail";
import { Notice } from "../../components/ui/primitives";
import { useResource } from "../../hooks/useResource";
import { albumSelection, loadAlbumDetail } from "./album-model";
import { CatalogAlbumScreen, CatalogAlbumRecordings } from "./CatalogAlbumScreen";

export function AlbumScreen() {
  const { serverUrl, user } = useAuth();
  return <AlbumRoute key={JSON.stringify([serverUrl, user?.id])} />;
}

function AlbumRoute() {
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
  const catalog = useCatalogCollection(id, detail.reload);
  const first = detail.data?.page.items[0];
  const title = detail.data?.page.title || collectionIdentity(id)?.album || "Album";
  const catalogStatus = catalog.data?.catalog.status;
  const catalogUnavailable = catalogStatus === "unavailable" || catalogStatus === "not_configured";
  return <CollectionDetail detail={detail} selection={albumSelection(id)}
    title={title} artwork={first?.thumb} artistLink={first}
    start={start} onStart={setStart} emptyTitle="Nothing imported yet"
    emptyMessage="This album has no songs in the catalog yet."
    annotation={catalog.items.length ? ` · ${catalog.items.length} more not imported yet` : ""}
    hideEmpty={catalog.loading || !!catalog.error || catalog.items.length > 0 || catalogUnavailable}
    afterTracks={<>
      <CatalogCollectionRows catalog={catalog} />
      {catalogStatus === "unavailable" ? <Notice title="More catalog music is unavailable"
        message="Your library remains available. Try again shortly." retry={catalog.reload} /> :
        catalogStatus === "not_configured" ? <Notice title="Catalog search is not configured"
          message="Your library and any connected catalog editions remain available." /> : null}
      <CatalogAlbumRecordings key={id} id={id} local collectionItems={catalog.items} />
    </>} />;
}
