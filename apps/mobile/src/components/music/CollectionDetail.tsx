import type { CatalogPage, PlayerCollection, PlayerItem } from "@mint/client";
import { useEffect, useRef, type ReactNode } from "react";
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useApi } from "../../api";
import { Artwork, Button, Notice } from "../ui/primitives";
import { TrackRow } from "../ui/music";
import { SongOptions } from "../ui/SongOptions";
import { usePlayer } from "../../playback/PlayerProvider";
import { usePlaybackAction } from "../../hooks/usePlaybackAction";
import { colors } from "../../theme/tokens";
import { screenStyles } from "./screen-styles";
import { detailPageSize } from "./detail-model";
import { useLikesRevision } from "../../hooks/useSongLike";

type DetailResource = { data: { page: CatalogPage } | null; loading: boolean; error: string | null; reload(): void };
type Props = {
  detail: DetailResource; selection: PlayerCollection; title: string; artwork?: string; round?: boolean; liked?: boolean;
  artistLink?: PlayerItem; annotation?: string; description?: string | null; actions?: ReactNode; beforeTracks?: ReactNode;
  emptyTitle?: string; emptyMessage?: string; start: number; onStart(start: number): void; children?: ReactNode;
  /** Rows continuing the song list on its last page, such as catalog songs not imported yet; suppresses the empty notice when `hideEmpty`. */
  afterTracks?: ReactNode; hideEmpty?: boolean;
  removeSong?: (item: PlayerItem) => (() => Promise<void>) | undefined; afterSong?: (item: PlayerItem) => ReactNode;
};

/** Presentation and bounded paging only; feature owners select APIs and authorize playlist controls. */
export function CollectionDetail({ detail, selection, title, artwork, round, liked, artistLink, annotation = "",
  description, actions, beforeTracks, emptyTitle = "No songs yet",
  emptyMessage = "There are no playable songs in this selection.", start, onStart, children, removeSong, afterSong, afterTracks, hideEmpty }: Props) {
  const api = useApi();
  const likesRevision = useLikesRevision(api);
  const previousLikesRevision = useRef(likesRevision);
  useEffect(() => {
    if (liked && previousLikesRevision.current !== likesRevision) detail.reload();
    previousLikesRevision.current = likesRevision;
  }, [liked, likesRevision, detail]);
  const player = usePlayer();
  const runPlayback = usePlaybackAction();
  const { width } = useWindowDimensions();
  const data = detail.data;
  return <ScrollView contentContainerStyle={screenStyles.page} keyboardShouldPersistTaps="handled">
    {detail.loading ? <Notice loading title="Loading your music" /> : detail.error
      ? <Notice title="Couldn't load this music" message={detail.error} retry={detail.reload} /> : data ? <>
        <View style={[detailStyles.hero, width < 600 && detailStyles.heroPhone]}>
          <Artwork uri={artwork ? api?.artworkUrl(artwork) : undefined} size={width < 600 ? 200 : 224} round={round} liked={liked} />
          <View style={detailStyles.heroText}>
            <Text accessibilityRole="header" style={detailStyles.title}>{title}</Text>
            {artistLink?.artistId ? <Pressable accessibilityRole="link" accessibilityLabel={`Open artist ${artistLink.artist}`}
              onPress={() => router.push({ pathname: "/artist/[id]", params: { id: artistLink.artistId } })}>
              <Text style={detailStyles.artist}>{artistLink.artist}</Text>
            </Pressable> : null}
            <Text style={detailStyles.secondary}>{data.page.total} {data.page.total === 1 ? "song" : "songs"}{annotation}</Text>
            {description ? <Text style={detailStyles.secondary}>{description}</Text> : null}
            <View style={screenStyles.shortcuts}>
              <Button label="Play" icon="play" disabled={!data.page.total} onPress={() => runPlayback(() => player.playCollection(selection))} />
              <Button label="Shuffle" icon="shuffle" quiet disabled={!data.page.total} onPress={() => runPlayback(() => player.playCollection(selection, { shuffle: true }))} />
              {actions}
            </View>
          </View>
        </View>
        {beforeTracks}
        {!data.page.items.length && !hideEmpty ? <Notice title={emptyTitle} message={emptyMessage} /> : null}
        {data.page.items.map((item) => <View key={item.occurrenceId ?? item.id}>
          <TrackRow item={item} onPress={() => runPlayback(() => player.playCollection(selection, { id: item.id, occurrenceId: item.occurrenceId }))}
            trailing={<SongOptions item={item} remove={removeSong?.(item)} />} />
          {afterSong?.(item)}
        </View>)}
        {start + data.page.items.length >= data.page.total ? afterTracks : null}
        {data.page.total > detailPageSize ? <View style={[screenStyles.shortcuts, { marginTop: 24 }]}>
          <Button label="Previous songs" quiet disabled={!start} onPress={() => onStart(Math.max(0, start - detailPageSize))} />
          <Button label="Next songs" quiet disabled={start + data.page.items.length >= data.page.total} onPress={() => onStart(start + detailPageSize)} />
          <Text style={detailStyles.secondary}>{start + 1}–{start + data.page.items.length} of {data.page.total}</Text>
        </View> : null}
        {children}
      </> : null}
  </ScrollView>;
}

export const detailStyles = StyleSheet.create({
  hero: { flexDirection: "row", alignItems: "flex-end", gap: 24, marginTop: 8, marginBottom: 24 },
  heroPhone: { flexDirection: "column", alignItems: "center" }, heroText: { flex: 1, width: "100%", gap: 14 },
  title: { color: colors.text, fontSize: 38, fontWeight: "800", letterSpacing: -.8 },
  artist: { color: colors.text, fontSize: 16, fontWeight: "600", textDecorationLine: "underline" },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 23 }, edit: { gap: 12, maxWidth: 440, marginBottom: 24 },
  overlay: { flex: 1, backgroundColor: "#000000b3", justifyContent: "center", padding: 24 },
  dialog: { width: "100%", maxWidth: 440, alignSelf: "center", padding: 24, backgroundColor: colors.surface, borderRadius: 16, gap: 20 },
  dialogTitle: { color: colors.text, fontSize: 24, fontWeight: "700" },
});
