import { useState } from "react";
import type { PlayerItem, RecordingSearchItem, SearchRequestView } from "@mint/client";
import { useLocalSearchParams } from "expo-router";
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../api";
import { useAuth } from "../../auth";
import { Button, Field, Notice, Section } from "../../components/ui/primitives";
import { MusicShelf, TrackRow } from "../../components/ui/music";
import { SongOptions } from "../../components/ui/SongOptions";
import { PageTitle } from "../../components/ui/PageTitle";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useResource } from "../../hooks/useResource";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors } from "../../theme/tokens";
import { screenStyles } from "../../components/music/screen-styles";
import {
  activeSearchRequest, canCancelSearchRequest, canRetrySearchRequest, catalogArtistItems, catalogText, isCurrentSearch,
  recordingActionLabel, recordingRequestInput, searchRequestCopy, searchRequestStatusLabel, shouldOfferSearchRequest,
  topSearchResult, uniqueRecordings, visibleCatalogResults,
} from "./search-model";
import { usePlaybackAction } from "../../hooks/usePlaybackAction";
import { BrowseAll } from "./BrowseAll";
import { CatalogAction, CatalogResults, CatalogRow } from "./CatalogResults";
import { CatalogRecordingActions, useCatalogRequests } from "../../components/music/catalog-requests";

export function SearchScreen() {
  const { serverUrl, user } = useAuth();
  return <SearchRoute key={JSON.stringify([serverUrl, user?.id])} />;
}

function SearchRoute() {
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
  const catalogRequests = useCatalogRequests(api);
  const requested = catalogRequests.stages;
  const [intentPending, setIntentPending] = useState<string | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);
  const local = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to search.");
    if (!query || query !== active) return null;
    const [songs, albums, artists] = await Promise.all([
      api.catalog({ type: "track", q: query, size: 50 }, signal),
      api.catalog({ type: "album", q: query, size: 18 }, signal),
      api.catalog({ type: "artist", q: query, size: 18 }, signal),
    ]);
    return { query, songs, albums, artists };
  }, [api, query, active]);
  const external = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to search.");
    if (query.length < 2 || query !== active) return null;
    // Freshness labels are relative to when the catalog answered, not to a clock read while rendering.
    return { query, result: await api.searchRecordings(query, signal), fetchedAt: Date.now() };
  }, [api, query, active]);
  const savedRequests = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to view search requests.");
    return api.listSearchRequests(signal);
  }, [api]);
  const searchRequests = savedRequests.data?.requests ?? [];
  const matchingRequest = activeSearchRequest(searchRequests, active);
  const current = isCurrentSearch(query, active);
  const found = current && local.data?.query === active ? local.data : null;
  const answered = current && external.data?.query === active ? external.data : null;
  const localSongs = found?.songs.items ?? [];
  const visible = answered ? visibleCatalogResults(localSongs, answered.result.results) : null;
  const recordings = answered ? uniqueRecordings(localSongs, answered.result.items) : [];
  const offerSearchRequest = shouldOfferSearchRequest({
    query: active,
    current,
    localReady: found !== null && !local.loading,
    localError: local.error !== null,
    localRecordingCount: localSongs.length,
    recordingsReady: external.data?.query === active && !external.loading,
    recordingsError: external.error !== null,
    recordingCount: recordings.length,
    catalogStatus: answered?.result.catalog.status ?? null,
    hasActiveRequest: matchingRequest !== null || savedRequests.loading,
  });
  function refreshSearchRequests() {
    setIntentError(null);
    savedRequests.reload();
  }
  async function saveSearchRequest() {
    if (!api) return;
    setIntentPending("create");
    setIntentError(null);
    try {
      await api.createSearchRequest(active);
      refreshSearchRequests();
    } catch (reason) {
      setIntentError(reason instanceof Error ? reason.message : "The search request could not be saved. Try again.");
    } finally {
      setIntentPending(null);
    }
  }
  async function mutateSearchRequest(request: SearchRequestView, action: "retry" | "cancel") {
    if (!api) return;
    setIntentPending(request.id);
    setIntentError(null);
    try {
      await api.actOnSearchRequest(request.id, action);
      refreshSearchRequests();
    } catch (reason) {
      setIntentError(reason instanceof Error ? reason.message : "The search request could not be updated. Try again.");
    } finally {
      setIntentPending(null);
    }
  }
  function confirmCancel(request: SearchRequestView) {
    // react-native-web's Alert.alert is a no-op, so the browser preview needs its own confirmation.
    if (Platform.OS === "web") {
      if (globalThis.confirm(`Cancel search request?\n\nStop checking metadata for “${request.query}”?`)) {
        void mutateSearchRequest(request, "cancel");
      }
      return;
    }
    Alert.alert("Cancel search request?", `Stop checking metadata for “${request.query}”?`, [
      { text: "Keep request", style: "cancel" },
      { text: "Cancel request", style: "destructive", onPress: () => void mutateSearchRequest(request, "cancel") },
    ]);
  }
  async function request(recording: RecordingSearchItem, like: boolean) {
    const result = await catalogRequests.request(recording, like, recordingRequestInput(recording.token, searchRequests, active));
    if (result && matchingRequest) refreshSearchRequests();
  }
  function recordingAction(recording: RecordingSearchItem) {
    const existing = recording.existing;
    if (existing?.playable) {
      return <CatalogAction label="Play" accessibilityLabel={recordingActionLabel("Play", recording)} onPress={() => {
        runPlayback(() => player.playTrack({
          id: existing.id, title: recording.title, artist: recording.artist, album: recording.album ?? undefined,
          duration: recording.durationSec ? recording.durationSec * 1000 : undefined,
        }));
      }} />;
    }
    return <CatalogRecordingActions recording={recording} state={catalogRequests.requested.get(recording.id)}
      busy={catalogRequests.pending === recording.id} disabled={catalogRequests.pending !== null}
      onLike={() => void request(recording, true)} onImport={() => void request(recording, false)} />;
  }
  const catalogArtists = catalogArtistItems(found?.artists.items ?? [], answered?.result.artists ?? []);
  const catalogAnswered = answered?.result.catalog.status === "ok" || answered?.result.catalog.status === "lexical-only";
  const top = topSearchResult(active,
    [...localSongs, ...(found?.albums.items ?? []), ...(found?.artists.items ?? [])],
    catalogArtists, catalogAnswered ? visible?.rows ?? [] : []);
  const featured = top?.source === "catalog" ? top.row : null;
  const isTopItem = (item: PlayerItem) => top && top.source !== "catalog" &&
    top.item.id === item.id && top.item.type === item.type;
  const songs = localSongs.filter((item) => !isTopItem(item));
  const albums = (found?.albums.items ?? []).filter((item) => !isTopItem(item));
  const artists = [...(found?.artists.items ?? []), ...catalogArtists].filter((item) => !isTopItem(item));
  const catalogRows = visible?.rows.filter((row) => row !== featured) ?? [];
  const catalogSection = active.length < 2 ? <Text style={s.secondary}>{catalogText.shortQuery}</Text> :
    !current || external.loading ? <Notice loading title="Searching Mint's music catalog" /> :
      external.error ? <Notice title="Catalog search couldn't load" message={external.error} retry={external.reload} /> :
        answered && visible ? <CatalogResults catalog={answered.result.catalog} rows={catalogRows} featured={featured} hiddenCount={visible.hiddenCount}
          query={active} now={answered.fetchedAt} requested={requested} onRetry={external.reload} renderAction={recordingAction} /> : null;
  const searchRequestsPanel = <SearchRequestsPanel requests={searchRequests} loading={savedRequests.loading}
    error={savedRequests.error} onRefresh={refreshSearchRequests} onRetry={(item) => void mutateSearchRequest(item, "retry")}
    onCancel={confirmCancel} pendingId={intentPending} actionError={intentError} />;
  return <View style={s.screen}>
    <View style={[screenStyles.page, s.header]}>
      <PageTitle title="Search" />
      <Field label="What do you want to listen to?" value={input} maxLength={100} onChangeText={setInput}
        placeholder="Artists, songs, or albums" returnKeyType="search" autoCorrect={false} clearButtonMode="while-editing" />
    </View>
    {!active ? <BrowseAll footer={searchRequestsPanel} /> : <ScrollView style={s.screen} contentContainerStyle={screenStyles.page} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {!current || local.loading ? <Notice loading title="Searching your music" /> : local.error ? <Notice title="Library search couldn't load" message={local.error} retry={local.reload} /> : null}
      {top ? <Section title="Top result">
        {top.source === "catalog" && answered ? <CatalogRow row={top.row} now={answered.fetchedAt}
          requestedStage={top.row.recording ? requested.get(top.row.recording.id) : undefined} renderAction={recordingAction} /> :
          top.source !== "catalog" && top.item.type === "track" ? <TrackRow item={top.item} trailing={<SongOptions item={top.item} />} /> :
            top.source !== "catalog" ? <MusicShelf items={[top.item]} /> : null}
      </Section> : null}
      {songs.length ? <Section title="Songs">{songs.map((item) => <TrackRow key={item.id} item={item} trailing={<SongOptions item={item} />} />)}</Section> : null}
      {albums.length ? <Section title="Albums"><MusicShelf items={albums} /></Section> : null}
      {artists.length ? <Section title="Artists"><MusicShelf items={artists} /></Section> : null}
      <Section title="Beyond your library">
        {catalogSection}
        {offerSearchRequest ? <Section title="Can't find it?">
          <Text style={s.secondary}>{searchRequestCopy.offer}</Text>
          <Button label="Ask Mint to look for it" busy={intentPending === "create"} disabled={intentPending !== null}
            onPress={() => void saveSearchRequest()} />
          {intentError ? <Notice title="Couldn't save this search request" message={intentError} /> : null}
        </Section> : null}
        {requested.size ? <Button label="Refresh results" quiet onPress={external.reload} /> : null}
        {catalogRequests.error ? <Notice title="Couldn't add this song" message={catalogRequests.error} /> : null}
      </Section>
      {found && !found.songs.items.length && !found.albums.items.length && !found.artists.items.length ? <Notice title="No library matches" message="Try a different spelling, or check Beyond your library below." /> : null}
      {searchRequestsPanel}
    </ScrollView>}
  </View>;
}

function SearchRequestsPanel({ requests, loading, error, onRefresh, onRetry, onCancel, pendingId, actionError }: {
  requests: SearchRequestView[]; loading: boolean; error: string | null; onRefresh: () => void;
  onRetry: (request: SearchRequestView) => void; onCancel: (request: SearchRequestView) => void;
  pendingId: string | null; actionError: string | null;
}) {
  return <Section title="Search requests">
    <Text style={s.secondary}>{searchRequestCopy.panel}</Text>
    <Button label="Refresh request status" quiet busy={loading} onPress={onRefresh} />
    {error ? <Notice title="Search requests couldn't load" message={error} retry={onRefresh} /> : null}
    {loading && !requests.length ? <Notice loading title="Loading saved requests" /> : null}
    {!loading && !error && !requests.length ? <Text style={s.secondary}>You have no saved search requests.</Text> : null}
    {requests.map((request) => <View key={request.id} style={s.requestRow}>
      <View style={s.metadata}>
        <Text style={s.title}>{request.query}</Text>
        <Text style={s.secondary}>{searchRequestStatusLabel(request)}</Text>
      </View>
      {canRetrySearchRequest(request) ? <Button label="Retry check" quiet busy={pendingId === request.id}
        disabled={pendingId !== null} onPress={() => onRetry(request)} /> : null}
      {canCancelSearchRequest(request) ? <Button label="Cancel request" quiet busy={pendingId === request.id}
        disabled={pendingId !== null} onPress={() => onCancel(request)} /> : null}
    </View>)}
    {actionError ? <Notice title="Search request couldn't be updated" message={actionError} /> : null}
  </Section>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, header: { paddingBottom: 4 },
  requestRow:  { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.elevated },
  metadata: { flex: 1, minWidth: 180, gap: 6 }, title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 21 },
});
