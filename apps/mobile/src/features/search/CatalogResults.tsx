import type { ReactNode } from "react";
import type { CatalogCoverage, CatalogResult, RecordingSearchItem } from "@mint/client";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Notice, styles as ui } from "../../components/ui/primitives";
import { colors } from "../../theme/tokens";
import {
  catalogEmptyMessage, catalogNotes, catalogProvenance, catalogState, catalogSubtitle, catalogText,
  catalogUnavailableMessage, popularityLabel, recordingLibraryLabel, splitCatalogResults,
} from "./search-model";

/** Presentational only: the screen that owns library actions supplies each identified row's action. */
export function CatalogResults({ catalog, rows, hiddenCount, query, now, requested, onRetry, renderAction }: {
  catalog: CatalogCoverage;
  rows: readonly CatalogResult[];
  hiddenCount: number;
  query: string;
  now: number;
  requested: ReadonlyMap<string, string>;
  onRetry: () => void;
  renderAction: (recording: RecordingSearchItem) => ReactNode;
}) {
  const state = catalogState(catalog, rows, hiddenCount);
  if (state === "not-configured") return <Notice title={catalogText.notConfiguredTitle} message={catalogText.notConfigured} />;
  if (state === "unavailable") {
    return <Notice title={catalogText.unavailableTitle} message={catalogUnavailableMessage(catalog.retryAfterSeconds)} retry={onRetry} />;
  }
  const { matched, related } = splitCatalogResults(rows);
  const notes = catalogNotes(catalog, state);
  const empty = catalogEmptyMessage(state, query);
  const renderRow = (row: CatalogResult) => <CatalogRow key={row.key} row={row} now={now}
    requestedStage={row.recording ? requested.get(row.recording.id) : undefined} renderAction={renderAction} />;
  const closest = state === "related-only";
  return <>
    {notes.intro.map((note) => <Text key={note} style={s.secondary}>{note}</Text>)}
    {empty ? <Text style={s.secondary}>{empty}</Text> : null}
    {matched.map(renderRow)}
    {related.length ? <View style={s.related}>
      <Text accessibilityRole="header" style={s.subheading}>{closest ? catalogText.closestTitle : catalogText.relatedTitle}</Text>
      <Text style={s.secondary}>{closest ? catalogText.closest : catalogText.related}</Text>
    </View> : null}
    {related.map(renderRow)}
    {notes.footer.map((note) => <Text key={note} style={s.secondary}>{note}</Text>)}
  </>;
}

function CatalogRow({ row, now, requestedStage, renderAction }: {
  row: CatalogResult; now: number; requestedStage: string | undefined; renderAction: (recording: RecordingSearchItem) => ReactNode;
}) {
  const popularity = popularityLabel(row.popularity);
  const recording = row.recording;
  return <View style={s.row}>
    <View style={s.metadata}>
      <Text style={s.title}>{row.title}</Text>
      <Text style={s.secondary}>{catalogSubtitle(row)}</Text>
      <Text style={s.secondary}>{catalogProvenance(row, now)}</Text>
      {popularity ? <Text style={s.secondary}>{popularity}</Text> : null}
      <Text style={s.secondary}>{recording ? recordingLibraryLabel(recording, requestedStage) : catalogText.unconfirmed}</Text>
    </View>
    {recording ? renderAction(recording) : null}
  </View>;
}

/** Looks like the shared quiet Button, but carries a longer accessible name that identifies the song. */
export function CatalogAction({ label, accessibilityLabel, onPress, disabled, busy }: {
  label: string; accessibilityLabel: string; onPress: () => void; disabled?: boolean; busy?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => [ui.button, ui.quiet, (disabled || busy) && ui.disabled, pressed && ui.pressed]}>
    {busy ? <ActivityIndicator color={colors.text} /> : null}
    <Text style={[ui.buttonText, { color: colors.text }]}>{label}</Text>
  </Pressable>;
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.elevated },
  metadata: { flex: 1, minWidth: 180, gap: 6 }, title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  related: { gap: 6, marginTop: 8 }, subheading: { color: colors.text, fontSize: 18, fontWeight: "700" },
});
