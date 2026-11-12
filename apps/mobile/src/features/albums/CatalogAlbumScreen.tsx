import { externalCatalogPageSchema, type ExternalCatalogItem, type MintApi, type RecordingSearchItem } from "@mint/client";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useApi } from "../../api";
import { detailStyles } from "../../components/music/CollectionDetail";
import { screenStyles } from "../../components/music/screen-styles";
import { PageTitle } from "../../components/ui/PageTitle";
import { Button, Notice } from "../../components/ui/primitives";
import { useResource } from "../../hooks/useResource";
import { visibleBridgeRecordings } from "./album-model";

const noCollectionItems: RecordingSearchItem[] = [];
const noBridgeItems: ExternalCatalogItem[] = [];

export function CatalogAlbumScreen({ id, title, artist }: { id: string; title: string; artist: string }) {
  return <ScrollView contentContainerStyle={screenStyles.page}>
    <PageTitle title={title} />
    <Text style={detailStyles.secondary}>{artist}</Text>
    <CatalogAlbumRecordings id={id} />
  </ScrollView>;
}

export function CatalogAlbumRecordings({ id, local = false, collectionItems = noCollectionItems }: {
  id: string; local?: boolean; collectionItems?: RecordingSearchItem[];
}) {
  const api = useApi();
  const [after, setAfter] = useState<string | null>(null);
  const [pending, setPending] = useState<{ api: MintApi; id: string } | null>(null);
  const [outcome, setOutcome] = useState<{ api: MintApi; message: string; error: boolean } | null>(null);
  const resource = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to browse the catalog.");
    const params = new URLSearchParams({ limit: "50" });
    if (after) params.set("after", after);
    return api.request(`catalog/${local ? "library-albums" : "albums"}/${id}/recordings?${params}`, externalCatalogPageSchema, { signal });
  }, [api, id, after, local]);
  const bridgeItems = resource.data?.items ?? noBridgeItems;
  const visible = visibleBridgeRecordings(bridgeItems, collectionItems);
  async function request(recordingId: string, token: string) {
    if (!api || pending?.api === api) return;
    setPending({ api, id: recordingId }); setOutcome(null);
    try {
      const result = await api.requestRecording({ token });
      setOutcome({ api, error: false, message: result.stage === "ready" || result.stage === "analyzing" ?
        "This recording is already indexed. Open your library to choose its playable edition." :
        "Recording requested. It will be available in your library when ready." });
    } catch (error) {
      setOutcome({ api, error: true, message: error instanceof Error ? error.message : "This recording could not be requested." });
    } finally { setPending((current) => current?.api === api ? null : current); }
  }
  if (local && (resource.data?.configured === false || resource.data?.identityVerified === false)) return null;
  return <View>
    <Text style={detailStyles.secondary}>MusicBrainz catalog recordings are separate from playable library songs. Add only music you are authorized to acquire.</Text>
    {resource.loading ? <Notice loading title="Loading album recordings" /> : resource.error ?
      <Notice title="Album recordings unavailable" message={resource.error} retry={resource.reload} /> : null}
    {resource.data?.configured === false ? <Notice title="Catalog not connected" message="Your playable library is unchanged." /> : null}
    {resource.data?.configured && !resource.data.items.length ? <Notice
      title={local ? "No additional recordings on this page" : "No recordings populated yet"}
      message={local ? resource.data.nextCursor ? "More recordings may be available on the next page." : "Your library is unchanged." :
        "Try again after the catalog has refreshed this album."} retry={resource.reload} /> : null}
    {resource.data?.items.length && !visible.length ?
      <Text style={detailStyles.secondary}>These catalog recordings are already listed above.</Text> : null}
    {visible.map((recording) => <View key={recording.id} style={{ paddingVertical: 16, gap: 8 }}>
      <Text style={detailStyles.artist}>{recording.title}</Text>
      <Text style={detailStyles.secondary}>{recording.artist} - Catalog recording, not playable here</Text>
      {recording.requestToken ? <Button quiet label="Add to library" busy={pending?.api === api && pending.id === recording.id}
        disabled={pending?.api === api} onPress={() => void request(recording.id, recording.requestToken!)} /> : null}
    </View>)}
    {outcome?.api === api ? <Notice title={outcome.error ? "Couldn't request this recording" : "Request result"} message={outcome.message} /> : null}
    {after ? <Button quiet label="First recording page" onPress={() => setAfter(null)} /> : null}
    {resource.data?.nextCursor ? <Button quiet label="More recordings" onPress={() => setAfter(resource.data!.nextCursor)} /> : null}
  </View>;
}
