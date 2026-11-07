import type { CatalogPage, ChartDefinition, Discovery } from "@mint/client";
import { useMemo, useState } from "react";
import { FlatList, Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useApi } from "../api";
import { BrowseCard } from "../components/ui/BrowseCard";
import { Notice } from "../components/ui/primitives";
import { useBrowseCatalog, type SourceKey } from "../hooks/useBrowseCatalog";
import { colors, layout } from "../theme/tokens";
import {
  browseRows, categoryCards, chartCards, facetOrder, facetTitles, gridColumns, mixTitles, personalCards,
  type BrowseRow, type BrowseSection, type MixMode, type SectionStatus,
} from "./browse-model";

const mixes = Object.keys(mixTitles) as MixMode[];
const personalKeys: SourceKey[] = [...mixes, "albums"];

export function BrowseAll() {
  const api = useApi();
  const { width } = useWindowDimensions();
  const columns = gridColumns(width >= layout.wide ? width - layout.sidebar : width);
  const [listWidth, setListWidth] = useState(0);
  // Exact card widths keep partial rows aligned with full rows on every platform.
  const inner = Math.min(listWidth, 1440) - 40;
  const cardWidth = inner > 0 ? Math.floor((inner - 12 * (columns - 1)) / columns) : undefined;
  const browse = useBrowseCatalog(api);
  const { states, retrySources, loadMore } = browse;
  const rows = useMemo(() => {
    const ready = <T,>(key: SourceKey) => { const state = states[key]; return state.status === "ready" ? state.data as T : undefined; };
    const status = (keys: SourceKey[]): SectionStatus => {
      const failed = keys.filter((key) => states[key].status === "error");
      const first = failed.length ? states[failed[0]!] : null;
      return { loading: keys.some((key) => states[key].status === "loading"),
        error: first?.status === "error" ? first.error : null, retry: () => retrySources(failed) };
    };
    const charts = ready<{ charts: ChartDefinition[] }>("charts");
    const sections: BrowseSection[] = [
      { key: "you", title: "For you", status: status(personalKeys), cards: personalCards({
        mixes: Object.fromEntries(mixes.map((mode) => [mode, ready<Discovery>(mode)])), albums: ready<CatalogPage>("albums") }) },
      { key: "charts", title: "Charts", status: status(["charts"]), cards: charts ? chartCards(charts.charts) : [] },
      ...facetOrder.map((facet) => ({ key: facet, title: facetTitles[facet], cards: (browse.facets[facet] ?? []).flatMap(categoryCards) })),
    ];
    return browseRows(sections, columns);
  }, [states, browse.facets, columns, retrySources]);
  const settled = Object.values(states).every((state) => state.status !== "loading");
  const empty = settled && browse.facetsExhausted && !browse.facetsError && !rows.length;

  return <FlatList<BrowseRow> data={rows} keyExtractor={(row) => row.key} style={s.list} contentContainerStyle={s.page}
    onLayout={(event) => setListWidth(event.nativeEvent.layout.width)}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" initialNumToRender={8} maxToRenderPerBatch={8}
    windowSize={9} removeClippedSubviews={Platform.OS === "android"} onEndReachedThreshold={0.8} onEndReached={() => loadMore()}
    renderItem={({ item: row }) => row.type === "header"
      ? <Text accessibilityRole="header" style={s.heading}>{row.title}</Text>
      : row.type === "status" ? <View style={s.status}>{row.status.error
        ? <Notice title={`${row.title} couldn't load`} message={row.status.error} retry={row.status.retry} />
        : <Notice loading />}</View>
      : <View style={s.row}>{row.cards.map((card) => <BrowseCard key={card.key} card={card} width={cardWidth} />)}
        {cardWidth ? null : Array.from({ length: columns - row.cards.length }, (_, index) => <View key={`spacer-${index}`} style={s.spacer} />)}</View>}
    ListFooterComponent={<View style={s.footer}>
      {browse.facetsLoading ? <Notice loading /> : browse.facetsError ?
        <Notice title="More categories couldn't load" message={browse.facetsError} retry={() => loadMore(true)} /> : null}
      {empty ? <Notice title="Nothing to browse yet" message="Categories appear as music with years, moods or genres arrives in your library. Search above to find something now." /> : null}
    </View>} />;
}

const s = StyleSheet.create({
  list: { flex: 1 },
  page: { paddingHorizontal: 20, paddingBottom: 40, maxWidth: 1440, width: "100%", alignSelf: "center" },
  heading: { color: colors.text, fontSize: 22, fontWeight: "800", letterSpacing: -.4, marginTop: 28, marginBottom: 14 },
  row: { flexDirection: "row", gap: 12, marginBottom: 12 },
  spacer: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  footer: { minHeight: 40 },
  status: { marginBottom: 12 },
});
