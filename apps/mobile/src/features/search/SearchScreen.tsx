import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { SectionList, StyleSheet, Text, View } from "react-native";
import type { PlayerItem, RecordingSearchItem } from "@mint/client";
import { useApi } from "../../api";
import { Button, Field, Notice } from "../../components/ui/primitives";
import { MusicShelf, TrackRow } from "../../components/ui/music";
import { SongOptions } from "../../components/ui/SongOptions";
import { PageTitle } from "../../components/ui/PageTitle";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useResource } from "../../hooks/useResource";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors } from "../../theme/tokens";
import { screenStyles } from "../../components/music/screen-styles";
import { isCurrentSearch, uniqueRecordings } from "./search-model";
import { useLocalSearchPage } from "./useLocalSearchPage";
import { usePlaybackAction } from "../../hooks/usePlaybackAction";
import { BrowseAll } from "./BrowseAll";

type SearchRow =
  | { kind: "track"; item: PlayerItem }
  | { kind: "shelf"; items: PlayerItem[] }
  | { kind: "recording"; item: RecordingSearchItem }
  | { kind: "local-error"; source: string; error: string; retry: () => void };
type SearchSection = {
  key: "songs" | "albums" | "artists" | "recordings";
  title: string;
  data: SearchRow[];
  page?: ReturnType<typeof useLocalSearchPage>;
};

export function SearchScreen() {
  const api = useApi();
  const player = usePlayer();
  const runPlayback = usePlaybackAction();
  const params = useLocalSearchParams<{ q?: string }>();
  const initial = typeof params.q === "string" ? params.q.slice(0, 100) : "";
  const [input, setInput] = useState(initial);
  const [linked, setLinked] = useState(initial);
  // A Search link (for example from a chart entry) replaces the query once per distinct link.
  if (initial !== linked) { setLinked(initial); setInput(initial); }
  const active = input.trim();
  const query = useDebouncedValue(active, 450);
  const [pending, setPending] = useState<string | null>(null);
  const [requested, setRequested] = useState<Map<string, string>>(new Map());
  const [requestError, setRequestError] = useState<string | null>(null);
  const current = isCurrentSearch(query, active);
  const enabled = current && active.length > 0;
  const songs = useLocalSearchPage((start, size, signal) => {
    if (!api) throw new Error("Sign in to search.");
    return api.catalog({ type: "track", q: query, start, size }, signal);
  }, 50, [api, query], enabled);
  const albums = useLocalSearchPage((start, size, signal) => {
    if (!api) throw new Error("Sign in to search.");
    return api.catalog({ type: "album", q: query, start, size }, signal);
  }, 18, [api, query], enabled);
  const artists = useLocalSearchPage((start, size, signal) => {
    if (!api) throw new Error("Sign in to search.");
    return api.catalog({ type: "artist", q: query, start, size }, signal);
  }, 18, [api, query], enabled);
  const external = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to search.");
    if (query.length < 2 || query !== active) return null;
    return { query, result: await api.searchRecordings(query, signal) };
  }, [api, query, active]);
  const recordings = current && external.data?.query === active ?
    uniqueRecordings(songs.items, external.data.result.items) : [];
  const withLocalError = (source: string, page: ReturnType<typeof useLocalSearchPage>, rows: SearchRow[]) =>
    page.error && !page.items.length ? [...rows, { kind: "local-error" as const, source, error: page.error, retry: page.retry }] : rows;
  const allSections: SearchSection[] = [
    { key: "songs", title: "Songs", page: songs, data: withLocalError("Songs", songs, songs.items.map((item) => ({ kind: "track", item }))) },
    { key: "albums", title: "Albums", page: albums, data: withLocalError("Albums", albums, albums.items.length ? [{ kind: "shelf", items: albums.items }] : []) },
    { key: "artists", title: "Artists", page: artists, data: withLocalError("Artists", artists, artists.items.length ? [{ kind: "shelf", items: artists.items }] : []) },
    { key: "recordings", title: "Beyond your library", data: recordings.map((item) => ({ kind: "recording", item })) },
  ];
  const sections = allSections.filter((section) => !section.page || section.page.total !== 0 || section.page.loading || !!section.page.error);
  const localPages = [songs, albums, artists];
  const noLocalMatches = current && localPages.every((page) => page.total === 0 && !page.loading && !page.error);
  const initialLocalLoading = current && localPages.some((page) => page.loading && page.total === null);
  async function request(id: string, token: string) {
    if (!api) return;
    setPending(id); setRequestError(null);
    try {
      const result = await api.requestRecording({ token });
      setRequested((previous) => new Map(previous).set(id, result.stage));
    } catch (reason) { setRequestError(reason instanceof Error ? reason.message : "This song could not be added. Try again."); }
    finally { setPending(null); }
  }
  return <View style={s.screen}>
    <View style={[screenStyles.page, s.header]}>
      <PageTitle title="Search" />
      <Field label="What do you want to listen to?" value={input} maxLength={100} onChangeText={setInput}
        placeholder="Artists, songs, or albums" returnKeyType="search" autoCorrect={false} clearButtonMode="while-editing" />
    </View>
    {!active ? <BrowseAll /> : <SectionList<SearchRow, SearchSection> style={s.screen} contentContainerStyle={screenStyles.page} sections={sections}
        keyExtractor={(item, index) => item.kind === "track" ? `track:${item.item.id}` : item.kind === "shelf" ? `shelf:${index}` :
          item.kind === "recording" ? `recording:${item.item.id}` : `error:${item.source}`}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={s.heading}>{section.title}</Text>}
        renderItem={({ item }) => {
          if (item.kind === "track") return <TrackRow item={item.item} trailing={<SongOptions item={item.item} />} />;
          if (item.kind === "shelf") return <MusicShelf items={item.items} />;
          if (item.kind === "local-error") return <Notice title={`${item.source} couldn't load`} message={item.error} retry={item.retry} />;
          const recording = item.item;
          const existing = recording.existing;
          const playable = existing?.playable;
          const added = requested.has(recording.id);
          return <View style={s.recording}><View style={s.metadata}>
            <Text style={s.title}>{recording.title}</Text><Text style={s.secondary}>{recording.artist}{recording.album ? ` · ${recording.album}` : ""}</Text>
            <Text style={s.secondary}>{playable ? "In your library" : added ? requested.get(recording.id) === "ready" ? "In your library · Refresh results to play" : "Requested · Available once ready" : recording.existing ? `Not ready · ${recording.existing.stage}` : "Not in your library"}</Text>
          </View>
            {playable && existing ? <Button label="Play" quiet onPress={() => {
              runPlayback(() => player.playTrack({
                id: existing.id, title: recording.title, artist: recording.artist, album: recording.album ?? undefined,
                duration: recording.durationSec ? recording.durationSec * 1000 : undefined,
              }));
            }} /> : <Button label={added ? "Requested" : "Add to library"} quiet busy={pending === recording.id} disabled={added || pending !== null}
              onPress={() => void request(recording.id, recording.token)} />}
          </View>;
        }}
        renderSectionFooter={({ section }) => section.page ? <LocalPageFooter title={section.title} page={section.page} /> :
          <View style={s.footer}>
            <Text style={s.secondary}>Recording metadata from MusicBrainz. Add only music you are authorized to acquire.</Text>
            {active.length < 2 ? <Text style={s.secondary}>Type at least two characters to search the wider catalog.</Text> :
              !current || external.loading ? <Notice loading title="Searching the wider catalog" /> :
                external.error ? <Notice title="Wider search couldn't load" message={external.error} retry={external.reload} /> : null}
            {current && !external.loading && !external.error && active.length >= 2 && !recordings.length ? <Text style={s.secondary}>No additional recordings found. Try another title or artist.</Text> : null}
            {requested.size ? <Button label="Refresh results" quiet onPress={external.reload} /> : null}
            {requestError ? <Notice title="Couldn't add this song" message={requestError} /> : null}
          </View>}
        ListHeaderComponent={<>
          {!current || initialLocalLoading ? <Notice loading title="Searching your music" /> : null}
          {noLocalMatches ? <Notice title="No library matches" message="Try a different spelling or choose a recording from the wider catalog." /> : null}
        </>}
        initialNumToRender={12} maxToRenderPerBatch={12} windowSize={9} onEndReachedThreshold={0.6}
        ListFooterComponent={<View style={s.footer} />} />
    }
  </View>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, header: { paddingBottom: 4 }, heading: { color: colors.text, fontSize: 24, fontWeight: "700", letterSpacing: -.4, marginTop: 32, marginBottom: 8 },
  footer: { minHeight: 48, gap: 8, paddingVertical: 8 }, pageActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  recording: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.elevated },
  metadata: { flex: 1, minWidth: 180, gap: 6 }, title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 21 },
});

function LocalPageFooter({ title, page }: { title: string; page: SearchSection["page"] }) {
  if (!page) return null;
  const label = title.toLowerCase();
  const emptyError = page.error && !page.items.length;
  return <View style={s.footer}>
    {page.error && !emptyError ? <Notice title={`More ${label} couldn't load`} message={page.error} retry={page.retry} /> : null}
    {page.loading && page.items.length ? <Notice loading title={`Loading ${label}`} /> : null}
    {page.total !== null ? <Text style={s.secondary}>
      {page.total === 0 ? `No ${label} found` :
        `Showing ${page.start + 1}–${page.end} of ${page.total.toLocaleString("en-US")} ${label}`}
    </Text> : null}
    <View style={s.pageActions}>
      {page.start > 0 && !page.loading && !page.error ? <Button label={`Previous ${label}`} quiet onPress={page.loadPrevious} /> : null}
      {page.next !== null && !page.loading && !page.error ? <Button label={`More ${label}`} quiet onPress={page.loadMore} /> : null}
      {page.total !== null && page.total > 0 && page.next === null && !page.loading ? <Text style={s.secondary}>{`End of ${label}`}</Text> : null}
    </View>
  </View>;
}
