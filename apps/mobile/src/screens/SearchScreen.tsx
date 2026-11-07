import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../api";
import { Button, Field, Notice, Section } from "../components/ui/primitives";
import { MusicShelf, TrackRow } from "../components/ui/music";
import { SongOptions } from "../components/ui/SongOptions";
import { PageTitle } from "../components/ui/PageTitle";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useResource } from "../hooks/useResource";
import { usePlayer } from "../playback/PlayerProvider";
import { colors } from "../theme/tokens";
import { screenStyles } from "./HomeScreen";
import { isCurrentSearch, uniqueRecordings } from "./search-model";
import { usePlaybackAction } from "../hooks/usePlaybackAction";
import { BrowseAll } from "./BrowseAll";

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
    return { query, result: await api.searchRecordings(query, signal) };
  }, [api, query, active]);
  const current = isCurrentSearch(query, active);
  const found = current && local.data?.query === active ? local.data : null;
  const recordings = current && external.data?.query === active ?
    uniqueRecordings(found?.songs.items ?? [], external.data.result.items) : [];
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
    {!active ? <BrowseAll /> : <ScrollView style={s.screen} contentContainerStyle={screenStyles.page} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {!current || local.loading ? <Notice loading title="Searching your music" /> : local.error ? <Notice title="Library search couldn't load" message={local.error} retry={local.reload} /> : null}
      {found?.songs.items.length ? <Section title="Songs">{found.songs.items.map((item) => <TrackRow key={item.id} item={item} trailing={<SongOptions item={item} />} />)}</Section> : null}
      {found?.albums.items.length ? <Section title="Albums"><MusicShelf items={found.albums.items} /></Section> : null}
      {found?.artists.items.length ? <Section title="Artists"><MusicShelf items={found.artists.items} /></Section> : null}
      <Section title="Beyond your library">
        <Text style={s.secondary}>Recording metadata from MusicBrainz. Add only music you are authorized to acquire.</Text>
        {active.length < 2 ? <Text style={s.secondary}>Type at least two characters to search the wider catalog.</Text> :
          !current || external.loading ? <Notice loading title="Searching the wider catalog" /> :
            external.error ? <Notice title="Wider search couldn't load" message={external.error} retry={external.reload} /> : null}
        {recordings.map((recording) => {
          const existing = recording.existing;
          const playable = existing?.playable;
          const added = requested.has(recording.id);
          return <View key={recording.id} style={s.recording}><View style={s.metadata}>
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
        })}
        {current && !external.loading && !external.error && active.length >= 2 && !recordings.length ? <Text style={s.secondary}>No additional recordings found. Try another title or artist.</Text> : null}
        {requested.size ? <Button label="Refresh results" quiet onPress={external.reload} /> : null}
        {requestError ? <Notice title="Couldn't add this song" message={requestError} /> : null}
      </Section>
      {found && !found.songs.items.length && !found.albums.items.length && !found.artists.items.length ? <Notice title="No library matches" message="Try a different spelling or choose a recording from the wider catalog." /> : null}
    </ScrollView>}
  </View>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, header: { paddingBottom: 4 },
  recording: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.elevated },
  metadata: { flex: 1, minWidth: 180, gap: 6 }, title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 21 },
});
