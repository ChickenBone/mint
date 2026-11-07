import type { ChartPage, PlayerItem } from "@mint/client";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState, type ReactNode } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useApi } from "../../api";
import { MusicCard, MusicShelf, TrackRow } from "../../components/ui/music";
import { Artwork, Button, Notice, Section } from "../../components/ui/primitives";
import { SongOptions } from "../../components/ui/SongOptions";
import { usePagedResource } from "../../hooks/usePagedResource";
import { usePlaybackAction } from "../../hooks/usePlaybackAction";
import { useResource } from "../../hooks/useResource";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors, layout } from "../../theme/tokens";
import {
  cardColor, catalogFilters, chartStatus, mixTitles, parseBrowseTarget, safeArtworkUrl, titleCase, type BrowseTarget, type MixMode,
} from "./browse-model";

const text = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;
const listProps = { initialNumToRender: 12, maxToRenderPerBatch: 12, windowSize: 9, onEndReachedThreshold: 0.6,
  removeClippedSubviews: Platform.OS === "android", keyboardShouldPersistTaps: "handled" as const };

export function BrowseCategoryScreen() {
  const params = useLocalSearchParams<{ facet?: string; value?: string; title?: string }>();
  const target = parseBrowseTarget(text(params.facet), text(params.value));
  if (!target) return <View style={s.page}><Notice title="This category isn't available" message="It may have been renamed or removed. Return to Search to browse what's in your library now." />
    <Button label="Back to Search" quiet onPress={() => router.replace("/search")} /></View>;
  const key = `${target.facet}:${target.value}`;
  if (target.facet === "chart") return <ChartCategory key={key} id={target.value} />;
  if (target.facet === "mix") return <MixCategory key={key} mode={target.value} />;
  if (target.facet === "new") return <NewArrivals key={key} />;
  return <FilteredCategory key={key} target={target} title={categoryTitle(target, text(params.title))} />;
}

function categoryTitle(target: BrowseTarget, linked?: string) {
  if (target.facet === "decade") return `${target.value}s`;
  if (target.facet === "mood") return titleCase(target.value);
  // Only accept a linked display label that names the same genre, never arbitrary URL text.
  return linked && linked.trim().toLowerCase() === target.value.toLowerCase() ? linked.trim() : titleCase(target.value);
}

function Hero({ colorKey, title, detail, children }: { colorKey: string; title: string; detail?: string | null; children?: ReactNode }) {
  return <View style={[s.hero, { backgroundColor: cardColor(colorKey) }]}>
    <Text accessibilityRole="header" numberOfLines={3} style={s.heroTitle}>{title}</Text>
    {detail ? <Text style={s.heroDetail}>{detail}</Text> : null}
    {children}
  </View>;
}

function Footer({ loading, error, retry, empty }: { loading: boolean; error: string | null; retry: () => void; empty?: ReactNode }) {
  return <View style={s.footer}>{loading ? <Notice loading /> : error ? <Notice title="Couldn't load more" message={error} retry={retry} /> : empty ?? null}</View>;
}

function FilteredCategory({ target, title }: { target: BrowseTarget; title: string }) {
  const api = useApi();
  const player = usePlayer();
  const run = usePlaybackAction();
  const filters = catalogFilters(target)!;
  const filterKey = JSON.stringify(filters);
  const albums = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to browse.");
    return api.catalog({ type: "album", filters, size: 18 }, signal);
  }, [api, filterKey]);
  const songs = usePagedResource(async (start, signal) => {
    if (!api) throw new Error("Sign in to browse.");
    const page = await api.catalog({ type: "track", filters, start, size: 50 }, signal);
    const end = page.start + page.items.length;
    return { items: page.items, total: page.total, next: end < page.total && page.items.length ? end : null };
  }, (item) => item.occurrenceId ?? item.id, [api, filterKey]);
  const collection = { kind: "library" as const, filters };
  const count = songs.total ?? 0;
  return <FlatList<PlayerItem> {...listProps} data={songs.items} keyExtractor={(item) => item.occurrenceId ?? item.id}
    contentContainerStyle={s.page} onEndReached={songs.loadMore}
    renderItem={({ item }) => <TrackRow item={item} trailing={<SongOptions item={item} />} />}
    ListHeaderComponent={<>
      <Hero colorKey={`${target.facet}:${target.value}`} title={title}
        detail={songs.total === null ? null : `${count.toLocaleString("en-US")} ${count === 1 ? "song" : "songs"} in your library`}>
        <View style={s.actions}>
          <Button label="Play" icon="play" disabled={!count} onPress={() => run(() => player.playCollection(collection))} />
          <Button label="Shuffle" icon="shuffle" quiet disabled={!count} onPress={() => run(() => player.playCollection(collection, { shuffle: true }))} />
        </View>
      </Hero>
      {albums.data?.items.length ? <Section title="Albums"><MusicShelf items={albums.data.items} /></Section>
        : albums.error ? <Section title="Albums"><Notice title="Albums couldn't load" message={albums.error} retry={albums.reload} /></Section>
        : albums.loading ? <Section title="Albums"><Notice loading /></Section> : null}
      {songs.items.length ? <Text accessibilityRole="header" style={s.heading}>Songs</Text> : null}
    </>}
    ListFooterComponent={<Footer loading={songs.loading} error={songs.error} retry={songs.retry}
      empty={songs.total === 0 ? <Notice title="No songs here yet" message="Nothing playable in your library matches this category right now." /> : null} />} />;
}

function NewArrivals() {
  const api = useApi();
  const { width } = useWindowDimensions();
  const content = Math.min(1440, width >= layout.wide ? width - layout.sidebar : width) - 40;
  const columns = Math.max(2, Math.floor((content + 16) / 168));
  const albums = usePagedResource(async (start, signal) => {
    if (!api) throw new Error("Sign in to browse.");
    const page = await api.catalog({ type: "album", sort: "newest", start, size: 30 }, signal);
    const end = page.start + page.items.length;
    return { items: page.items, total: page.total, next: end < page.total && page.items.length ? end : null };
  }, (item) => item.id, [api]);
  return <FlatList<PlayerItem> {...listProps} key={`albums-${columns}`} numColumns={columns} data={albums.items}
    keyExtractor={(item) => item.id} contentContainerStyle={s.page} columnWrapperStyle={columns > 1 ? s.grid : undefined}
    onEndReached={albums.loadMore} renderItem={({ item }) => <MusicCard item={item} />}
    ListHeaderComponent={<Hero colorKey="new:albums" title="New arrivals" detail="Albums most recently added to your library" />}
    ListFooterComponent={<Footer loading={albums.loading} error={albums.error} retry={albums.retry}
      empty={albums.total === 0 ? <Notice title="No albums yet" message="Albums appear here as soon as they are ready to play." /> : null} />} />;
}

function MixCategory({ mode }: { mode: MixMode }) {
  const api = useApi();
  const mix = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to browse.");
    return api.discover(mode, signal);
  }, [api, mode]);
  const items = mix.data?.items ?? [];
  return <FlatList {...listProps} data={items} keyExtractor={(entry) => entry.item.id} contentContainerStyle={s.page}
    renderItem={({ item: entry }) => <TrackRow item={entry.item} subtitle={`${entry.item.artist ?? "Unknown artist"} · ${entry.reason}`}
      trailing={<SongOptions item={entry.item} />} />}
    ListHeaderComponent={<Hero colorKey={`mix:${mode}`} title={mixTitles[mode].title} detail={mix.data?.explanation ?? mixTitles[mode].detail} />}
    ListFooterComponent={<Footer loading={mix.loading} error={mix.error} retry={mix.reload}
      empty={mix.data && !items.length ? <Notice title="Nothing here yet" message="Like songs and keep listening to shape this mix." /> : null} />} />;
}

type ChartRow = ChartPage["items"][number];
function ChartCategory({ id }: { id: string }) {
  const api = useApi();
  // Chart metadata and its ranking revision belong to one account and chart; anything else is hidden immediately.
  const revision = useRef<{ api: typeof api; id: string; value: string | null } | null>(null);
  const [owned, setMeta] = useState<{ api: typeof api; id: string; page: Omit<ChartPage, "items"> } | null>(null);
  const meta = owned && owned.api === api && owned.id === id ? owned.page : null;
  const rows = usePagedResource(async (start, signal) => {
    if (!api) throw new Error("Sign in to browse.");
    const current = revision.current?.api === api && revision.current.id === id ? revision.current.value : null;
    const page = await api.chart(id, start, start ? current : null, signal);
    if (signal.aborted) throw new Error("Chart request was replaced.");
    if (!start) {
      revision.current = { api, id, value: page.revision };
      setMeta({ api, id, page });
    }
    return { items: page.items, total: page.total, next: page.nextOffset !== null && page.nextOffset > start ? page.nextOffset : null };
  }, (row) => row.id, [api, id]);
  const changed = rows.status === 409;
  const detail = meta ? [`${meta.chart.providerName} · ${meta.chart.territory}`, meta.period].filter(Boolean).join("\n") : null;
  return <FlatList<ChartRow> {...listProps} data={rows.items} keyExtractor={(row) => row.id} contentContainerStyle={s.page}
    onEndReached={rows.loadMore} renderItem={({ item }) => <ChartEntry row={item} />}
    ListHeaderComponent={<>
      <Hero colorKey={`chart:${id}`} title={meta?.chart.title ?? "Chart"} detail={detail} />
      {meta?.chart.description ? <Text style={s.caption}>{meta.chart.description}</Text> : null}
      {meta?.status === "stale" ? <Text style={s.caption}>Showing the last saved ranking while the provider is unavailable.</Text> : null}
      {meta?.notice && meta.status !== "fresh" ? <Notice title={meta.status === "error" ? "This chart couldn't update" : "Chart notice"} message={meta.notice} /> : null}
    </>}
    ListFooterComponent={changed ? <View style={s.footer}><Notice title="This chart just updated" message="Reload it to see the latest order." />
      <Button label="Reload chart" quiet onPress={rows.reload} /></View> :
      <Footer loading={rows.loading} error={rows.error} retry={rows.retry}
        empty={rows.total === 0 && meta?.status !== "error" ? <Notice title="No entries right now" message="The provider has not published entries for this chart." /> : null} />} />;
}

function ChartEntry({ row }: { row: ChartRow }) {
  const api = useApi();
  const player = usePlayer();
  const run = usePlaybackAction();
  const status = chartStatus(row.availability, row.progress);
  const playable = row.availability === "available" && row.item;
  const uri = safeArtworkUrl(api, row.item?.thumb ?? row.artwork, "Chart entry");
  const body = <>
    <Text style={[s.rank, !playable && s.muted]}>{row.rank}</Text>
    <Artwork uri={uri} size={48} />
    <View style={s.entry}>
      <Text numberOfLines={1} style={[s.entryTitle, !playable && s.muted]}>{row.title}</Text>
      <Text numberOfLines={1} style={s.entryDetail}>{row.artist}{playable ? "" : ` · ${status}`}</Text>
    </View>
  </>;
  return <View style={s.chartRow}>
    {playable ? <Pressable accessibilityRole="button" accessibilityLabel={`Play number ${row.rank}, ${row.title} by ${row.artist}`}
      onPress={() => run(() => player.playTrack(row.item!))} style={({ pressed }) => [s.chartMain, pressed && s.pressed]}>{body}</Pressable> :
      <View accessible accessibilityLabel={`Number ${row.rank}, ${row.title} by ${row.artist}. ${status}`} style={s.chartMain}>{body}</View>}
    {playable ? <SongOptions item={row.item!} /> :
      <Pressable accessibilityRole="button" accessibilityLabel={`Search for ${row.title} by ${row.artist}`} style={({ pressed }) => [s.find, pressed && s.pressed]}
        onPress={() => router.push({ pathname: "/search", params: { q: `${row.title} ${row.artist}`.slice(0, 100) } })}>
        <Text style={s.findText}>Search</Text>
      </Pressable>}
  </View>;
}

const s = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingBottom: 40, maxWidth: 1440, width: "100%", alignSelf: "center" },
  hero: { borderRadius: 8, paddingHorizontal: 20, paddingTop: 48, paddingBottom: 20, gap: 8, marginTop: 4, marginBottom: 12 },
  heroTitle: { color: "#ffffff", fontSize: 40, lineHeight: 44, fontWeight: "800", letterSpacing: -1 },
  heroDetail: { color: "rgba(255,255,255,0.88)", fontSize: 14, lineHeight: 20, fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  heading: { color: colors.text, fontSize: 24, fontWeight: "700", letterSpacing: -.4, marginTop: 32, marginBottom: 8 },
  caption: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 16, maxWidth: 640 },
  footer: { minHeight: 48, gap: 8 },
  grid: { gap: 16, marginTop: 16 },
  chartRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 68 },
  chartMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  pressed: { opacity: .75 },
  rank: { width: 28, textAlign: "right", color: colors.text, fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  entry: { flex: 1, minWidth: 0, gap: 4 },
  entryTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  entryDetail: { color: colors.muted, fontSize: 14 },
  muted: { color: colors.muted },
  find: { minHeight: 44, minWidth: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: colors.elevated, alignItems: "center", justifyContent: "center" },
  findText: { color: colors.text, fontSize: 14, fontWeight: "700" },
});
