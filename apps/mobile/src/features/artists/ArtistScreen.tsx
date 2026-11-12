import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { collectionIdentity } from "@mint/client";
import { useApi } from "../../api";
import { useAuth } from "../../auth";
import { CatalogCollectionRows, useCatalogCollection } from "../../components/music/CatalogCollectionSection";
import { detailPageSize } from "../../components/music/detail-model";
import { detailStyles } from "../../components/music/CollectionDetail";
import { screenStyles } from "../../components/music/screen-styles";
import { TrackRow } from "../../components/ui/music";
import { Artwork, Button, Notice, Section } from "../../components/ui/primitives";
import { SongOptions } from "../../components/ui/SongOptions";
import { usePlaybackAction } from "../../hooks/usePlaybackAction";
import { useResource } from "../../hooks/useResource";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors } from "../../theme/tokens";
import { artistSelection, loadArtistDetail, mergeArtistAlbums } from "./artist-model";
import { CatalogArtistAlbums } from "./CatalogArtistAlbums";

export function ArtistScreen() {
  const { serverUrl, user } = useAuth();
  return <ArtistRoute key={JSON.stringify([serverUrl, user?.id])} />;
}

function ArtistRoute() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const api = useApi();
  const player = usePlayer();
  const runPlayback = usePlaybackAction();
  const { width } = useWindowDimensions();
  const [start, setStart] = useState(0);
  const [section, setSection] = useState<"songs" | "albums">("songs");
  const detail = useResource((signal) => loadArtistDetail(api, id, start, signal), [api, id, start]);
  const catalog = useCatalogCollection(id, detail.reload);
  const data = detail.data;
  const first = data?.page.items[0];
  const title = data?.page.title || collectionIdentity(id)?.artist || "Artist";
  const albums = mergeArtistAlbums(data?.albums.items ?? [], catalog.albums);
  const selection = artistSelection(id);
  const artistMbid = data?.albums.artistProfile?.status === "ready" ? data.albums.artistProfile.musicBrainzArtistId : null;
  const catalogStatus = catalog.data?.catalog.status;
  const catalogUnavailable = catalogStatus === "unavailable" || catalogStatus === "not_configured";
  const catalogNotice = catalogStatus === "unavailable" ?
    <Notice title="More catalog music is unavailable" message="Your library remains available. Try again shortly." retry={catalog.reload} /> :
    catalogStatus === "not_configured" ?
      <Notice title="Catalog search is not configured" message="Your library and any connected catalog editions remain available." /> : null;

  return <ScrollView contentContainerStyle={screenStyles.page} keyboardShouldPersistTaps="handled">
    {detail.loading ? <Notice loading title="Loading your music" /> : detail.error ?
      <Notice title="Couldn't load this music" message={detail.error} retry={detail.reload} /> : data ? <>
        <View style={[detailStyles.hero, width < 600 && detailStyles.heroPhone]}>
          <Artwork uri={first ? api?.artworkUrl(`/api/artwork/${first.id}?variant=artist`) : undefined}
            size={width < 600 ? 200 : 224} round />
          <View style={detailStyles.heroText}>
            <Text accessibilityRole="header" style={detailStyles.title}>{title}</Text>
            <Text style={detailStyles.secondary}>{data.page.total} {data.page.total === 1 ? "song" : "songs"}
              {catalog.items.length ? ` · ${catalog.items.length} more not imported yet` : ""}</Text>
            <View style={screenStyles.shortcuts}>
              <Button label="Play" icon="play" disabled={!data.page.total} onPress={() => runPlayback(() => player.playCollection(selection))} />
              <Button label="Shuffle" icon="shuffle" quiet disabled={!data.page.total}
                onPress={() => runPlayback(() => player.playCollection(selection, { shuffle: true }))} />
            </View>
          </View>
        </View>
        <View accessibilityRole="tablist" accessibilityLabel="Artist content" style={s.tabs}>
          {(["songs", "albums"] as const).map((value) => <Pressable key={value} accessibilityRole="tab"
            accessibilityLabel={value === "songs" ? "Songs" : "Albums"} accessibilityState={{ selected: section === value }}
            onPress={() => setSection(value)} style={({ pressed }) => [s.tab, section === value && s.selected, pressed && s.pressed]}>
            <Text style={[s.tabText, section === value && s.selectedText]}>{value === "songs" ? "Songs" : "Albums"}</Text>
          </Pressable>)}
        </View>
        {section === "songs" ? <Section title="Songs">
          {!data.page.items.length && !catalog.loading && !catalog.error && !catalog.items.length && !catalogUnavailable ?
            <Notice title="Nothing imported yet" message="This artist has no songs in the catalog yet." /> : null}
          {data.page.items.map((item) => <TrackRow key={item.occurrenceId ?? item.id} item={item}
            onPress={() => runPlayback(() => player.playCollection(selection, { id: item.id, occurrenceId: item.occurrenceId }))}
            trailing={<SongOptions item={item} />} />)}
          {start + data.page.items.length >= data.page.total ? <>
            <CatalogCollectionRows catalog={catalog} albumFilter />
            {catalogNotice}
          </> : null}
          {data.page.total > detailPageSize ? <View style={[screenStyles.shortcuts, { marginTop: 24 }]}>
            <Button label="Previous songs" quiet disabled={!start} onPress={() => setStart(Math.max(0, start - detailPageSize))} />
            <Button label="Next songs" quiet disabled={start + data.page.items.length >= data.page.total} onPress={() => setStart(start + detailPageSize)} />
            <Text style={detailStyles.secondary}>{start + 1}–{start + data.page.items.length} of {data.page.total}</Text>
          </View> : null}
        </Section> : <>
          {catalog.loading ? <Notice loading title="Looking for catalog albums" /> : catalog.error ?
            <Notice title="More albums couldn't load" message={catalog.error} retry={catalog.reload} /> : catalogNotice}
          <CatalogArtistAlbums key={artistMbid ?? id} artistMbid={artistMbid}
            albums={albums} waiting={catalog.loading || !!catalog.error || catalogUnavailable} />
        </>}
        {data.page.artistProfile?.profile?.biography ? <Section title="About the artist">
          <Text style={detailStyles.secondary}>{data.page.artistProfile.profile.biography}</Text>
          <Text style={detailStyles.secondary}>Artist information from MusicBrainz and Wikipedia.</Text>
        </Section> : null}
      </> : null}
  </ScrollView>;
}

const s = StyleSheet.create({
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tab: { minWidth: 88, minHeight: 48, paddingHorizontal: 18, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: colors.elevated },
  selected: { backgroundColor: colors.action },
  tabText: { color: colors.text, fontSize: 14, fontWeight: "700" },
  selectedText: { color: colors.actionInk },
  pressed: { opacity: .75 },
});
