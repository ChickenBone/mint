import Ionicons from "@expo/vector-icons/Ionicons";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Artwork } from "../ui/primitives";
import { useApi } from "../../api";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors } from "../../theme/tokens";
import { artworkPalette } from "./colors";
import { dragProgress, recentVelocity, settleExpanded, type DragSample } from "./gesture";
import { neutralPalette, type ArtworkPalette } from "./palette";
import { LyricsPanel } from "./LyricsPanel";
import { SeekSlider } from "./SeekSlider";

type IconName = ComponentProps<typeof Ionicons>["name"];
function Action({ label, icon, onPress, active = false, large = false, disabled = false }: {
  label: string; icon: IconName; onPress(): void; active?: boolean; large?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected: active }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [s.action, large && s.largeAction, pressed && s.pressed, disabled && s.disabled]}>
    <Ionicons name={icon} size={large ? 32 : 24} color={large ? colors.actionInk : active ? colors.action : colors.text} />
  </Pressable>;
}
const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, "0")}`;

export function PlayerSurface({ bottomInset = 0 }: { bottomInset?: number }) {
  const player = usePlayer(), api = useApi(), insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [palette, setPalette] = useState<ArtworkPalette>(neutralPalette), [oldPalette, setOldPalette] = useState<ArtworkPalette>(neutralPalette);
  const [presented, setPresented] = useState(false), [panel, setPanel] = useState<"song" | "lyrics" | "queue">("song");
  const [operationError, setOperationError] = useState<string | null>(null), [seekValue, setSeekValue] = useState<number | null>(null);
  const [reduced, setReduced] = useState(false);
  const [progress] = useState(() => new Animated.Value(0)), [tint] = useState(() => new Animated.Value(1));
  const currentProgress = useRef(0), samples = useRef<DragSample[]>([]), start = useRef(0);
  const dragging = useRef(false), lastPalette = useRef<ArtworkPalette>(neutralPalette);
  const expandedRef = useRef(player.expanded);
  const { open, close } = player;
  useEffect(() => { expandedRef.current = player.expanded; }, [player.expanded]);
  const track = player.state.track;
  const art = track?.thumb ? api?.artworkUrl(track.thumb) : undefined;
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (!cancelled) setReduced(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { cancelled = true; subscription.remove(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void artworkPalette(art).then((next) => {
      if (cancelled) return;
      setOldPalette(lastPalette.current); setPalette(next); lastPalette.current = next;
      tint.stopAnimation(); tint.setValue(0);
      Animated.timing(tint, { toValue: 1, duration: reduced ? 0 : 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    });
    return () => { cancelled = true; };
  }, [art, tint, reduced]);
  useEffect(() => {
    const listener = progress.addListener(({ value }) => { currentProgress.current = value; });
    return () => progress.removeListener(listener);
  }, [progress]);
  const settle = useCallback((expanded: boolean) => {
    if (expanded) { setPresented(true); open(); }
    else close();
    progress.stopAnimation();
    Animated.timing(progress, { toValue: expanded ? 1 : 0, duration: reduced ? 0 : 260,
      easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
      if (finished && !expanded && !expandedRef.current) setPresented(false);
    });
  }, [open, close, progress, reduced]);
  useEffect(() => {
    if (dragging.current) return;
    if (player.expanded) queueMicrotask(() => { setPresented(true); setPanel("song"); });
    progress.stopAnimation();
    Animated.timing(progress, { toValue: player.expanded ? 1 : 0, duration: reduced ? 0 : 260,
      easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
      if (finished && !player.expanded && !expandedRef.current) setPresented(false);
    });
  }, [player.expanded, progress, reduced]);
  // The native responder captures refs for event callbacks; its factory never reads them.
  // eslint-disable-next-line react-hooks/refs
  const pan = useMemo(() => createDragResponder({
    progress, currentProgress, samples, start, dragging, expandedRef, height, settle, present: () => setPresented(true),
  }), [height, progress, settle]);
  useEffect(() => {
    if (Platform.OS !== "web" || !presented) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [presented, close]);
  const run = (action: () => Promise<void>) => {
    setOperationError(null);
    void action().catch((error: unknown) => setOperationError(error instanceof Error ? error.message : "This action failed. Try again."));
  };
  const controls = <>
    <Action label={player.state.shuffle ? "Turn shuffle off" : "Turn shuffle on"} icon="shuffle" active={player.state.shuffle}
      disabled={player.state.queueLoading} onPress={() => run(() => player.setShuffle(!player.state.shuffle))} />
    <Action label="Previous song" icon="play-skip-back" onPress={() => run(player.previous)} />
    <Action label={player.state.playing ? "Pause" : "Play"} icon={player.state.playing ? "pause" : "play"} large onPress={() => run(player.toggle)} />
    <Action label="Next song" icon="play-skip-forward" onPress={() => run(player.next)} />
    <Action label={`Repeat: ${player.state.repeat}`} icon="repeat" active={player.state.repeat !== "off"}
      onPress={() => run(() => player.setRepeat(player.state.repeat === "off" ? "all" : player.state.repeat === "all" ? "one" : "off"))} />
  </>;
  if (!track) return player.state.error ? <View style={s.startError}><Text accessibilityLiveRegion="polite" style={s.error}>{player.state.error}</Text></View> : null;
  const coverSize = Math.min(width - 56, 360, Math.max(180, height * 0.4));
  const download = player.offline.entries.find((entry) => entry.id === track.id);
  return <>
    <View style={[s.mini, { marginBottom: bottomInset }]}>
      <LinearGradient colors={[oldPalette.primary, oldPalette.secondary]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: tint }]}>
        <LinearGradient colors={[palette.primary, palette.secondary]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open Now Playing: ${track.title || "current song"}`} onPress={player.open}
        {...pan.panHandlers} style={s.miniTrack}>
        <Artwork uri={art} size={48} />
        <View style={s.miniText}><Text numberOfLines={1} style={s.miniTitle}>{track.title || "Loading song"}</Text><Text numberOfLines={1} style={s.onColorSecondary}>{track.artist || "Mint"}</Text></View>
      </Pressable>
      {player.state.loading ? <ActivityIndicator accessibilityLabel="Buffering audio" color={colors.text} style={s.miniSpinner} /> : null}
      <Action label={player.state.playing ? "Pause" : "Play"} icon={player.state.playing ? "pause" : "play"} onPress={() => run(player.toggle)} />
      <Action label="Next song" icon="play-skip-forward" onPress={() => run(player.next)} />
      <View pointerEvents="none" style={s.miniProgress}><View style={[s.miniProgressFill, { width: `${Math.min(100, player.state.duration ? player.state.time / player.state.duration * 100 : 0)}%` }]} /></View>
    </View>
    <Modal visible={presented} transparent animationType="none" onRequestClose={player.close} statusBarTranslucent navigationBarTranslucent>
      <View style={s.modalRoot} accessibilityViewIsModal>
        <Animated.View style={[s.full, { transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }] }]}>
          <LinearGradient colors={[oldPalette.primary, oldPalette.secondary, oldPalette.bottom]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: tint }]}>
            <LinearGradient colors={[palette.primary, palette.secondary, palette.bottom]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
          </Animated.View>
          <View style={[s.header, { paddingTop: insets.top + 8 }]}>
            <Action label="Close Now Playing" icon="chevron-down" onPress={player.close} />
            <View {...pan.panHandlers} style={s.headerDrag}><Text style={s.headerTitle}>Now Playing</Text></View>
            <Action label="Show listening queue" icon="list" active={panel === "queue"} onPress={() => setPanel(panel === "queue" ? "song" : "queue")} />
          </View>
          <View style={[s.content, { paddingBottom: insets.bottom + 16 }]}>
            {panel === "song" ? <ScrollView contentContainerStyle={s.songContent} showsVerticalScrollIndicator={false}>
              <View {...pan.panHandlers} style={s.artworkDrag}><Artwork uri={art} size={coverSize} /></View>
              <View {...pan.panHandlers} style={s.metadata}><Text numberOfLines={2} style={s.title}>{track.title || "Loading song"}</Text>
                <Text numberOfLines={2} style={s.artist}>{track.artist || "Mint"}{track.album ? ` · ${track.album}` : ""}</Text></View>
              <View style={s.seek}>
                <SeekSlider duration={player.state.duration} value={seekValue ?? player.state.time} disabled={!player.state.duration}
                  onStart={setSeekValue} onChange={setSeekValue}
                  onComplete={(value) => { setSeekValue(null); run(() => player.seek(value)); }} />
                <View style={s.times}><Text style={s.onColorSecondary}>{clock(seekValue ?? player.state.time)}</Text><Text style={s.onColorSecondary}>{clock(player.state.duration)}</Text></View>
              </View>
              <View style={s.controls}>{controls}</View>
              {player.state.repeat === "one" ? <Text style={s.repeatHint}>Repeating this song</Text> : null}
              <View style={s.tools}>
                <Pressable accessibilityRole="button" accessibilityLabel="Lyrics" onPress={() => setPanel("lyrics")} style={s.tool}><Ionicons name="text" size={22} color={colors.text} /><Text style={s.toolText}>Lyrics</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Queue" onPress={() => setPanel("queue")} style={s.tool}><Ionicons name="list" size={22} color={colors.text} /><Text style={s.toolText}>Queue</Text></Pressable>
                {player.capabilities.offline ? <Pressable accessibilityRole="button" accessibilityLabel={download?.status === "ready" ? "Remove download" : download?.status === "failed" ? "Retry download" : "Download song"}
                  disabled={download?.status === "queued" || download?.status === "downloading"}
                  onPress={() => run(() => download?.status === "ready" ? player.removeDownload(track.id) : download?.status === "failed" ? player.retryDownload(track.id) : player.download(track))}
                  style={s.tool}><Ionicons name={download?.status === "ready" ? "checkmark-circle" : "download-outline"} size={22} color={colors.text} />
                  <Text style={s.toolText}>{download?.status === "ready" ? "Saved" : download?.status === "downloading" || download?.status === "queued" ? "Saving" : "Download"}</Text></Pressable> : null}
              </View>
              {player.state.loading ? <View style={s.buffer}><ActivityIndicator color={colors.text} /><Text style={s.onColorSecondary}>Loading audio</Text></View> : null}
            </ScrollView> : <>
              <View style={s.panelHeader}><Pressable accessibilityRole="button" accessibilityLabel="Back to song controls" onPress={() => setPanel("song")} style={s.back}>
                <Ionicons name="arrow-back" size={20} color={colors.text} /><Text style={s.toolText}>{panel === "lyrics" ? "Lyrics" : "Queue"}</Text></Pressable>
                {panel === "queue" ? <Pressable accessibilityRole="button" onPress={() => run(player.clearUpcoming)} style={s.back}><Text style={s.toolText}>Clear upcoming</Text></Pressable> : null}</View>
              {panel === "lyrics" ? <LyricsPanel /> : <ScrollView contentContainerStyle={s.queue} showsVerticalScrollIndicator={false}>
                <Text style={s.onColorSecondary}>{player.state.queueTotal} songs{player.state.queueLoading ? " · Preparing full queue" : ""}</Text>
                {player.state.queueLoading ? <Text style={s.onColorSecondary}>Loaded songs can continue in the background. Keep the app open while the rest loads.</Text> : null}
                {player.state.queue.length ? player.state.queue.map((entry, index) => <View key={entry.occurrenceId} style={s.queueRow}>
                  <View style={s.queueText}><Text numberOfLines={1} style={s.miniTitle}>{entry.title || "Song metadata loading"}</Text>
                    <Text numberOfLines={1} style={s.onColorSecondary}>{entry.artist || "Mint"}</Text></View>
                  {index > 0 ? <Action label={`Move ${entry.title || "song"} up`} icon="arrow-up" disabled={player.state.queueLoading}
                    onPress={() => run(() => player.moveInQueue(entry.occurrenceId, player.state.queue[index - 1]!.occurrenceId))} /> : null}
                  <Action label={`Remove ${entry.title || "song"} from queue`} icon="close" disabled={player.state.queueLoading}
                    onPress={() => run(() => player.removeFromQueue(entry.occurrenceId))} />
                </View>) : <Text style={s.onColorSecondary}>No songs up next. Add songs from their options menu.</Text>}
              </ScrollView>}
              <View style={s.compactControls}>{controls}</View>
            </>}
            {operationError || player.state.error ? <Text accessibilityLiveRegion="polite" style={s.error}>{operationError || player.state.error}</Text> : null}
          </View>
        </Animated.View>
      </View>
    </Modal>
  </>;
}

function createDragResponder({
  progress, currentProgress, samples, start, dragging, expandedRef, height, settle, present,
}: {
  progress: Animated.Value; currentProgress: { current: number }; samples: { current: DragSample[] };
  start: { current: number }; dragging: { current: boolean }; expandedRef: { current: boolean };
  height: number; settle(expanded: boolean): void; present(): void;
}) {
  return PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.2,
    onPanResponderGrant: () => {
      dragging.current = true;
      start.current = currentProgress.current;
      present();
      progress.stopAnimation((value) => { currentProgress.current = value; start.current = value; });
      samples.current = [];
    },
    onPanResponderMove: (_event, gesture) => {
      const now = Date.now();
      samples.current = [...samples.current.filter((sample) => now - sample.time <= 100), { y: gesture.dy, time: now }];
      progress.setValue(dragProgress(start.current, gesture.dy, height));
    },
    onPanResponderRelease: () => {
      dragging.current = false;
      settle(settleExpanded(currentProgress.current, recentVelocity(samples.current, Date.now())));
    },
    onPanResponderTerminate: () => { dragging.current = false; settle(expandedRef.current); },
    onPanResponderTerminationRequest: () => false,
  });
}

const s = StyleSheet.create({
  mini: { minHeight: 72, marginHorizontal: 8, marginTop: 4, borderRadius: 8, overflow: "hidden", flexDirection: "row", alignItems: "center", paddingHorizontal: 8 },
  miniTrack: { flex: 1, flexDirection: "row", gap: 12, alignItems: "center", minHeight: 64 }, miniText: { flex: 1, gap: 4 },
  miniTitle: { color: colors.text, fontSize: 15, fontWeight: "700" }, onColorSecondary: { color: "#d0dbd5", fontSize: 13, lineHeight: 20 },
  miniSpinner: { marginRight: 8 }, miniProgress: { position: "absolute", bottom: 0, left: 8, right: 8, height: 2, backgroundColor: "#ffffff33" },
  miniProgressFill: { height: 2, backgroundColor: colors.text }, action: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 28 },
  largeAction: { width: 68, height: 68, backgroundColor: colors.text, borderRadius: 34 }, pressed: { opacity: 0.7 }, disabled: { opacity: 0.5 },
  modalRoot: { flex: 1 }, full: { flex: 1, backgroundColor: colors.background }, header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16 },
  headerDrag: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 48 }, headerTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  content: { flex: 1, paddingHorizontal: 28, width: "100%", maxWidth: 760, alignSelf: "center", gap: 12 },
  songContent: { flexGrow: 1, justifyContent: "center", gap: 20, paddingTop: 12, paddingBottom: 12 }, artworkDrag: { alignItems: "center", paddingVertical: 8 },
  metadata: { gap: 8 }, title: { color: colors.text, fontSize: 27, lineHeight: 34, fontWeight: "800", letterSpacing: -0.5 },
  artist: { color: "#d0dbd5", fontSize: 16, lineHeight: 24 }, seek: { gap: 0 },
  times: { flexDirection: "row", justifyContent: "space-between" }, controls: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  tools: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" },
  tool: { minHeight: 44, flexDirection: "row", gap: 8, alignItems: "center" }, toolText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  repeatHint: { color: "#d0dbd5", textAlign: "center", fontSize: 13 }, buffer: { flexDirection: "row", gap: 8, alignItems: "center" },
  panelHeader: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", paddingVertical: 16 }, back: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  queue: { gap: 8, paddingBottom: 32 }, queueRow: { flexDirection: "row", gap: 8, alignItems: "center", minHeight: 64 }, queueText: { flex: 1, gap: 4 },
  compactControls: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12 },
  error: { color: "#ffbdb5", fontSize: 14, lineHeight: 20, paddingVertical: 8 }, startError: { paddingHorizontal: 20, paddingVertical: 12, backgroundColor: colors.surface },
});
