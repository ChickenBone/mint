import Ionicons from "@expo/vector-icons/Ionicons";
import { LinearGradient } from "expo-linear-gradient";
import { artistPlayerId, albumPlayerId } from "@mint/client";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentRef } from "react";
import { AccessibilityInfo, ActivityIndicator, BackHandler, findNodeHandle, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, ReduceMotion, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Artwork } from "../../components/ui/primitives";
import { useApi } from "../../api";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors } from "../../theme/tokens";
import { artworkPalette } from "./colors";
import { artworkTransform, dragAxis, dragProgress, sheetDestination, swipeTrack, type ArtworkFrame } from "./gesture";
import { neutralPalette, type ArtworkPalette } from "./palette";
import { LyricsPanel } from "./LyricsPanel";
import { SeekSlider } from "./SeekSlider";
import { StatsForNerds } from "./StatsForNerds";
import { useSongLike } from "../../hooks/useSongLike";
import { useSeekPreview } from "./useSeekPreview";

type IconName = ComponentProps<typeof Ionicons>["name"];
function Action({ label, icon, onPress, active = false, large = false, disabled = false, busy = false }: {
  label: string; icon: IconName; onPress(): void; active?: boolean; large?: boolean; disabled?: boolean; busy?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, selected: active, busy }}
    disabled={disabled || busy} onPress={onPress} style={({ pressed }) => [s.action, large && s.largeAction, pressed && s.pressed, disabled && s.disabled]}>
    {busy ? <ActivityIndicator color={colors.action} /> : <Ionicons name={icon} size={large ? 32 : 24} color={large ? colors.actionInk : active ? colors.action : colors.text} />}
  </Pressable>;
}
const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, "0")}`;

export function PlayerSurface({ bottomInset = 0, onPresentationChange }: { bottomInset?: number; onPresentationChange?(visible: boolean): void }) {
  const player = usePlayer(), api = useApi(), insets = useSafeAreaInsets();
  const { height, width, fontScale } = useWindowDimensions();
  const [palette, setPalette] = useState<ArtworkPalette>(neutralPalette), [oldPalette, setOldPalette] = useState<ArtworkPalette>(neutralPalette);
  const [presented, setPresented] = useState(false), [panel, setPanel] = useState<"song" | "lyrics" | "queue">("song");
  const [operationError, setOperationError] = useState<{ api: typeof api; id?: string; message: string } | null>(null);
  const [reduced, setReduced] = useState(false);
  const progress = useSharedValue(0), tint = useSharedValue(1), start = useSharedValue(0);
  const horizontal = useSharedValue(0), axis = useSharedValue<"horizontal" | "vertical" | "pending">("pending");
  const activationY = useSharedValue(0), activationX = useSharedValue(0), horizontalStart = useSharedValue(0);
  const touchX = useSharedValue(0), touchY = useSharedValue(0), scrollY = useSharedValue(0);
  const headerHeight = useSharedValue(insets.top + 64);
  const measured = useSharedValue(false);
  const isDragging = useSharedValue(false), dragCommitted = useSharedValue(false), settled = useSharedValue(false);
  const miniFrame = useSharedValue<ArtworkFrame>({ x: 16, y: height - 160, size: 48 });
  const fullFrame = useSharedValue<ArtworkFrame>({ x: (width - 280) / 2, y: 140, size: 280 });
  const overlay = useRef<ComponentRef<typeof View>>(null), miniArtwork = useRef<ComponentRef<typeof View>>(null), fullArtwork = useRef<ComponentRef<typeof View>>(null);
  const miniTitle = useRef<ComponentRef<typeof View>>(null);
  const lastPalette = useRef<ArtworkPalette>(neutralPalette);
  const expandedRef = useRef(player.expanded);
  const { open, close } = player;
  useEffect(() => { expandedRef.current = player.expanded; }, [player.expanded]);
  const track = player.state.track;
  const operationScope = useRef<{ api: typeof api; id?: string; active: boolean }>({ api, id: track?.id, active: true });
  useEffect(() => {
    operationScope.current = { api, id: track?.id, active: true };
    return () => { operationScope.current.active = false; };
  }, [api, track?.id]);
  const like = useSongLike(api, track?.id, presented);
  const art = track?.thumb ? api?.artworkUrl(track.thumb) : undefined;
  const coverSize = Math.min(width - insets.left - insets.right - 40, 360, Math.max(120, height * 0.38));
  const present = useCallback(() => { setPresented(true); }, []);
  const finishClose = useCallback(() => {
    if (expandedRef.current) return;
    setPresented(false);
    requestAnimationFrame(() => {
      void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
        if (!enabled || expandedRef.current) return;
        const handle = findNodeHandle(miniTitle.current);
        if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
      });
    });
  }, []);
  useEffect(() => { onPresentationChange?.(presented); }, [presented, onPresentationChange]);
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
      cancelAnimation(tint); tint.set(0);
      tint.set(withTiming(1, { duration: reduced ? 0 : 500, easing: Easing.bezier(0.23, 1, 0.32, 1), reduceMotion: ReduceMotion.System }));
    });
    return () => { cancelled = true; };
  }, [art, tint, reduced]);
  const commitExpanded = useCallback((expanded: boolean) => { if (expanded) open(); else close(); }, [open, close]);
  useEffect(() => {
    settled.set(player.expanded);
    if (player.expanded) queueMicrotask(() => { setPresented(true); });
    if (isDragging.get()) return;
    const target = player.expanded ? 1 : 0;
    // The gesture already handed its velocity to a spring; don't replace it with a zero-velocity effect.
    if (dragCommitted.get() && !reduced) { dragCommitted.set(false); return; }
    cancelAnimation(progress);
    progress.set(withSpring(target, { duration: reduced ? 0 : 300, dampingRatio: 0.8,
      overshootClamping: true, reduceMotion: ReduceMotion.System }, (finished) => {
      if (finished && target === 0) scheduleOnRN(finishClose);
    }));
  }, [player.expanded, reduced, settled, isDragging, dragCommitted, progress, finishClose]);
  useEffect(() => {
    if (!presented) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { close(); return true; });
    return () => subscription.remove();
  }, [presented, close]);
  useEffect(() => {
    if (Platform.OS !== "web" || !presented) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [presented, close]);
  const measureFrames = useCallback(() => {
    overlay.current?.measureInWindow((ox, oy) => {
      miniArtwork.current?.measureInWindow((x, y, size) => {
        if (size > 0) { miniFrame.set({ x: x - ox, y: y - oy, size }); measured.set(true); }
      });
      fullArtwork.current?.measureInWindow((x, y, size) => { if (size > 0) fullFrame.set({
        x: x - ox, y: y - oy + scrollY.get() - (reduced ? 0 : (1 - progress.get()) * height), size,
      }); });
    });
  }, [miniFrame, fullFrame, scrollY, reduced, progress, height, measured]);
  useEffect(() => { measureFrames(); }, [height, width, fontScale, panel, measureFrames]);
  useEffect(() => { if (panel !== "song") scrollY.set(0); }, [panel, scrollY]);
  const scroll = useAnimatedScrollHandler((event) => { scrollY.set(event.contentOffset.y); });
  const tintStyle = useAnimatedStyle(() => ({ opacity: tint.get() }));
  const miniStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.min(1, progress.get() * 3) }));
  const fullStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, progress.get() * 3),
    transform: [{ translateY: reduced ? 0 : (1 - progress.get()) * height }],
  }));
  const artworkStyle = useAnimatedStyle(() => {
    const full = { ...fullFrame.get(), y: fullFrame.get().y - scrollY.get() };
    const transform = artworkTransform(miniFrame.get(), full, reduced ? (settled.get() ? 1 : 0) : progress.get(), coverSize);
    return { opacity: measured.get() ? (panel === "song" ? 1 : 1 - progress.get()) : 0,
      transform: [{ translateX: transform.translateX + horizontal.get() },
        { translateY: transform.translateY - headerHeight.get() * progress.get() }, { scale: transform.scale }] };
  });
  const artworkClipStyle = useAnimatedStyle(() => ({ transform: [{ translateY: headerHeight.get() * progress.get() }] }));
  const swipeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: horizontal.get() }] }));
  const { next, previous } = player;
  const reportFailure = useCallback((error: unknown, scope: typeof operationScope.current) => {
    if (scope !== operationScope.current || !scope.active) return;
    setOperationError({ api: scope.api, id: scope.id, message: error instanceof Error ? error.message : "This action failed. Try again." });
  }, []);
  const skip = useCallback((direction: "next" | "previous") => {
    setOperationError(null);
    const scope = operationScope.current;
    void (direction === "next" ? next() : previous()).catch((error: unknown) => reportFailure(error, scope));
  }, [next, previous, reportFailure]);
  const makePan = useCallback((mini: boolean) => Gesture.Pan().manualActivation(true).maxPointers(1)
    .onTouchesDown((event) => {
      const touch = event.allTouches[0];
      if (touch) { touchX.set(touch.absoluteX); touchY.set(touch.absoluteY); axis.set("pending"); }
    })
    .onTouchesMove((event, manager) => {
      const touch = event.allTouches[0];
      if (!touch || event.numberOfTouches !== 1) { manager.fail(); return; }
      if (axis.get() !== "pending") return;
      const direction = dragAxis(touch.absoluteX - touchX.get(), touch.absoluteY - touchY.get());
      if (direction === "cancel" || (direction === "horizontal" && (!mini || progress.get() > 0.05))) { manager.fail(); return; }
      if (direction !== "pending") { axis.set(direction); manager.activate(); }
    })
    .onStart((event) => {
      isDragging.set(true); dragCommitted.set(false);
      cancelAnimation(progress); cancelAnimation(horizontal); start.set(progress.get());
      activationY.set(event.translationY); activationX.set(event.translationX); horizontalStart.set(horizontal.get());
      if (axis.get() === "vertical") scheduleOnRN(present);
    })
    .onUpdate((event) => {
      if (axis.get() === "vertical") progress.set(dragProgress(start.get(), event.translationY - activationY.get(), height));
      else horizontal.set(Math.max(-width * 0.35, Math.min(width * 0.35, horizontalStart.get() + event.translationX - activationX.get())));
    })
    .onEnd((event) => {
      isDragging.set(false);
      if (axis.get() === "vertical") {
        const expanded = sheetDestination(progress.get(), event.velocityY / 1000, settled.get(), false);
        dragCommitted.set(expanded !== settled.get()); settled.set(expanded);
        progress.set(withSpring(expanded ? 1 : 0, { duration: 300, dampingRatio: 0.8,
          velocity: -event.velocityY / Math.max(1, height), overshootClamping: true, reduceMotion: ReduceMotion.System }, (finished) => {
          if (finished && !expanded) scheduleOnRN(finishClose);
        }));
        scheduleOnRN(commitExpanded, expanded);
      } else {
        const direction = swipeTrack(event.translationX, event.velocityX, width);
        horizontal.set(withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: event.velocityX, reduceMotion: ReduceMotion.System }));
        if (direction) scheduleOnRN(skip, direction);
      }
    })
    .onFinalize((_event, success) => {
      if (success || !isDragging.get()) return;
      isDragging.set(false); dragCommitted.set(false);
      horizontal.set(withSpring(0, { duration: 300, dampingRatio: 1, reduceMotion: ReduceMotion.System }));
      const expanded = sheetDestination(progress.get(), 0, settled.get(), true);
      progress.set(withSpring(expanded ? 1 : 0, { duration: 300, dampingRatio: 1, reduceMotion: ReduceMotion.System }, (finished) => {
        if (finished && !settled.get()) scheduleOnRN(finishClose);
      }));
    }), [axis, touchX, touchY, isDragging, dragCommitted, progress, horizontal, start, activationY, activationX, horizontalStart, height, width, present, settled, finishClose, commitExpanded, skip]);
  // Factories only register callbacks; captured refs are read by events, never during render.
  // eslint-disable-next-line react-hooks/refs
  const pans = useMemo(() => ({ mini: makePan(true), header: makePan(false), art: makePan(true) }), [makePan]);
  const run = (action: () => Promise<void>) => {
    setOperationError(null);
    const scope = operationScope.current;
    void action().catch((error: unknown) => reportFailure(error, scope));
  };
  const seek = useSeekPreview(api, track?.occurrenceId, (value) => run(() => player.seek(value)));
  const seekValue = seek.value;
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
  const download = player.offline.entries.find((entry) => entry.id === track.id);
  const operationMessage = operationError?.id === track.id && operationError.api === api ? operationError.message : null;
  const artistId = track.artistId || (track.artist?.trim() ? artistPlayerId(track.artist) : undefined);
  const albumId = track.albumId || (track.artist?.trim() && track.album?.trim() ? albumPlayerId(track.artist, track.album) : undefined);
  const navigate = (destination: "artist" | "album") => {
    const id = destination === "artist" ? artistId : albumId;
    if (!id) return;
    player.close();
    router.push({ pathname: destination === "artist" ? "/artist/[id]" : "/album/[id]", params: { id } });
  };
  return <>
    <Animated.View style={[s.mini, { marginBottom: bottomInset }, miniStyle]}
      accessibilityElementsHidden={presented} importantForAccessibility={presented ? "no-hide-descendants" : "auto"}>
      <LinearGradient colors={[oldPalette.primary, oldPalette.secondary]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, tintStyle]}>
        <LinearGradient colors={[palette.primary, palette.secondary]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <View style={s.miniTrack}>
        <View ref={miniArtwork} collapsable={false} onLayout={measureFrames} style={s.miniArtwork} />
        <View style={s.miniText}>
          <GestureDetector gesture={pans.mini}><Animated.View style={swipeStyle}>
            <Pressable ref={miniTitle} accessibilityRole="button" accessibilityLabel={`Open Now Playing: ${track.title || "current song"}`}
              accessibilityActions={[{ name: "activate", label: "Open Now Playing" }, { name: "increment", label: "Next song" }, { name: "decrement", label: "Previous song" }]}
              onAccessibilityAction={(event) => event.nativeEvent.actionName === "increment" ? skip("next") : event.nativeEvent.actionName === "decrement" ? skip("previous") : player.open()}
              onPress={player.open} style={({ pressed }) => [s.miniTitleTarget, pressed && s.pressed]}>
              <Text numberOfLines={1} style={s.miniTitle}>{track.title || "Loading song"}</Text>
            </Pressable>
          </Animated.View></GestureDetector>
          <Pressable accessibilityRole="link" accessibilityLabel={`Open artist ${track.artist || "unavailable"}`} disabled={!artistId}
            onPress={() => navigate("artist")} style={({ pressed }) => [s.artistTarget, pressed && s.pressed]}>
            <Text numberOfLines={1} style={s.onColorSecondary}>{track.artist || "Mint"}</Text>
          </Pressable>
        </View>
      </View>
      <View style={s.miniControls}>
        <Action label={player.state.shuffle ? "Turn shuffle off" : "Turn shuffle on"} icon="shuffle" active={player.state.shuffle}
          disabled={player.state.queueLoading} onPress={() => run(() => player.setShuffle(!player.state.shuffle))} />
        <Action label={player.state.playing ? "Pause" : "Play"} icon={player.state.playing ? "pause" : "play"} onPress={() => run(player.toggle)} />
        <Action label="Next song" icon="play-skip-forward" onPress={() => run(player.next)} />
      </View>
      <View pointerEvents="none" style={s.miniProgress}><View style={[s.miniProgressFill, { width: `${Math.min(100, player.state.duration ? player.state.time / player.state.duration * 100 : 0)}%` }]} /></View>
    </Animated.View>
      <View ref={overlay} collapsable={false} onLayout={measureFrames} pointerEvents={presented ? "box-none" : "none"} style={s.overlay}
        accessibilityViewIsModal={presented} accessibilityElementsHidden={!presented} importantForAccessibility={presented ? "auto" : "no-hide-descendants"}>
        <Animated.View style={[s.full, fullStyle]}>
          <LinearGradient colors={[oldPalette.primary, oldPalette.secondary, oldPalette.bottom]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, tintStyle]}>
            <LinearGradient colors={[palette.primary, palette.secondary, palette.bottom]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
          </Animated.View>
          <View onLayout={(event) => headerHeight.set(event.nativeEvent.layout.height)}
            style={[s.header, { paddingTop: insets.top + 8, paddingLeft: insets.left + 8, paddingRight: insets.right + 8 }]}>
            <Action label="Close Now Playing" icon="chevron-down" onPress={player.close} />
            <GestureDetector gesture={pans.header}><Animated.View style={s.headerDrag}><Text style={s.headerTitle}>Now Playing</Text></Animated.View></GestureDetector>
            <Action label="Show listening queue" icon="list" active={panel === "queue"} onPress={() => setPanel(panel === "queue" ? "song" : "queue")} />
          </View>
          <View style={[s.content, { paddingBottom: insets.bottom + 16,
            paddingLeft: Math.max(width < 360 ? 16 : 28, insets.left + 16), paddingRight: Math.max(width < 360 ? 16 : 28, insets.right + 16) }]}>
            {panel === "song" ? <Animated.ScrollView onScroll={scroll} scrollEventThrottle={16} contentContainerStyle={s.songContent} showsVerticalScrollIndicator={false}>
              <View style={s.artworkDrag}><View ref={fullArtwork} collapsable={false} onLayout={measureFrames} style={{ width: coverSize, height: coverSize }} /></View>
              <View style={s.metadataRow}><View style={s.metadata}>
                <Pressable accessibilityRole={albumId ? "link" : "text"} accessibilityLabel={albumId ? `Open album ${track.album}` : track.title}
                  disabled={!albumId} onPress={() => navigate("album")} style={({ pressed }) => [s.titleTarget, pressed && s.pressed]}>
                  <Text numberOfLines={2} style={s.title}>{track.title || "Loading song"}</Text>
                </Pressable>
                <Pressable accessibilityRole="link" accessibilityLabel={`Open artist ${track.artist || "unavailable"}`} disabled={!artistId}
                  onPress={() => navigate("artist")} style={({ pressed }) => [s.artistTarget, pressed && s.pressed]}>
                  <Text numberOfLines={2} style={s.artist}>{track.artist || "Mint"}</Text>
                </Pressable>
                {track.album ? <Pressable accessibilityRole="link" accessibilityLabel={`Open album ${track.album}`} disabled={!albumId}
                  onPress={() => navigate("album")} style={({ pressed }) => [s.artistTarget, pressed && s.pressed]}>
                  <Text numberOfLines={1} style={s.onColorSecondary}>{track.album}</Text>
                </Pressable> : null}
              </View><View>
                  <Action label={like.liked === null ? "Loading song like" : like.liked ? "Remove from Liked songs" : "Add to Liked songs"}
                    icon={like.liked ? "heart" : "heart-outline"} busy={like.pending}
                    active={like.liked === true} disabled={!like.available || like.liked === null}
                    onPress={() => { void like.set(!like.liked).catch(() => {}); }} />
              </View></View>
              {like.error ? <View><Text accessibilityLiveRegion="polite" style={s.error}>{like.error}</Text>
                {like.liked === null ? <Action label="Retry loading song like" icon="refresh" onPress={like.retry} /> : null}</View> : null}
              <View style={s.seek}>
                <SeekSlider key={track.occurrenceId} duration={player.state.duration} value={seekValue ?? player.state.time} disabled={!player.state.duration}
                  onStart={seek.change} onChange={seek.change} onComplete={seek.complete} />
                <View style={s.times}><Text style={s.onColorSecondary}>{clock(seekValue ?? player.state.time)}</Text><Text style={s.onColorSecondary}>{clock(player.state.duration)}</Text></View>
              </View>
              <View style={s.controls}>{controls}</View>
              {player.state.repeat === "one" ? <Text style={s.repeatHint}>Repeating this song</Text> : null}
              <View style={s.tools}>
                <Pressable accessibilityRole="button" accessibilityLabel="Lyrics" onPress={() => setPanel("lyrics")} style={({ pressed }) => [s.tool, pressed && s.pressed]}><Ionicons name="text" size={22} color={colors.text} /><Text style={s.toolText}>Lyrics</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Queue" onPress={() => setPanel("queue")} style={({ pressed }) => [s.tool, pressed && s.pressed]}><Ionicons name="list" size={22} color={colors.text} /><Text style={s.toolText}>Queue</Text></Pressable>
                {player.capabilities.offline ? <Pressable accessibilityRole="button" accessibilityLabel={download?.status === "ready" ? "Remove download" : download?.status === "failed" ? "Retry download" : "Download song"}
                  disabled={download?.status === "queued" || download?.status === "downloading"}
                  onPress={() => run(() => download?.status === "ready" ? player.removeDownload(track.id) : download?.status === "failed" ? player.retryDownload(track.id) : player.download(track))}
                  style={({ pressed }) => [s.tool, pressed && s.pressed]}><Ionicons name={download?.status === "ready" ? "checkmark-circle" : "download-outline"} size={22} color={colors.text} />
                  <Text style={s.toolText}>{download?.status === "ready" ? "Saved" : download?.status === "downloading" || download?.status === "queued" ? "Saving" : "Download"}</Text></Pressable> : null}
              </View>
              {player.state.loading ? <View style={s.buffer}><ActivityIndicator color={colors.text} /><Text style={s.onColorSecondary}>Loading audio</Text></View> : null}
              {presented ? <StatsForNerds /> : null}
            </Animated.ScrollView> : <>
              <View style={s.panelHeader}><Pressable accessibilityRole="button" accessibilityLabel="Back to song controls" onPress={() => setPanel("song")} style={({ pressed }) => [s.back, pressed && s.pressed]}>
                <Ionicons name="arrow-back" size={20} color={colors.text} /><Text style={s.toolText}>{panel === "lyrics" ? "Lyrics" : "Queue"}</Text></Pressable>
                {panel === "queue" ? <Pressable accessibilityRole="button" onPress={() => run(player.clearUpcoming)} style={({ pressed }) => [s.back, pressed && s.pressed]}><Text style={s.toolText}>Clear upcoming</Text></Pressable> : null}</View>
              {panel === "lyrics" ? (presented ? <LyricsPanel /> : null) : <ScrollView contentContainerStyle={s.queue} showsVerticalScrollIndicator={false}>
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
            {operationMessage || player.state.error ? <Text accessibilityLiveRegion="polite" style={s.error}>{operationMessage || player.state.error}</Text> : null}
          </View>
        </Animated.View>
      </View>
    <Animated.View pointerEvents={presented && panel !== "song" ? "none" : "box-none"}
      accessibilityElementsHidden={presented && panel !== "song"} importantForAccessibility={presented && panel !== "song" ? "no-hide-descendants" : "auto"}
      style={[s.artworkClip, { height }, artworkClipStyle]}>
    <Animated.View style={[s.sharedArtwork, { width: coverSize, height: coverSize }, artworkStyle]}>
      <GestureDetector gesture={pans.art}>
        <Pressable accessibilityRole="button" accessibilityLabel={presented ? "Collapse Now Playing" : "Open Now Playing"}
          onPress={() => presented ? player.close() : player.open()} style={s.coverPress}>
          <Artwork uri={art} size={coverSize} />
          {!presented && player.state.loading ? <View pointerEvents="none" style={s.miniBuffer}>
            <ActivityIndicator accessibilityLabel="Buffering audio" color={colors.text} style={{ transform: [{ scale: coverSize / 48 }] }} /></View> : null}
        </Pressable>
      </GestureDetector>
    </Animated.View>
    </Animated.View>
  </>;
}

const s = StyleSheet.create({
  mini: { minHeight: 72, marginHorizontal: 8, marginTop: 4, borderRadius: 8, overflow: "hidden", flexDirection: "row", alignItems: "center", paddingHorizontal: 8 },
  miniTrack: { flex: 1, flexDirection: "row", gap: 8, alignItems: "center", minHeight: Platform.OS === "android" ? 96 : 88 }, miniText: { flex: 1, minWidth: 0 },
  miniArtwork: { width: 48, height: 48 }, miniTitleTarget: { minHeight: Platform.OS === "android" ? 48 : 44, justifyContent: "center" },
  artistTarget: { minHeight: Platform.OS === "android" ? 48 : 44, justifyContent: "center" },
  titleTarget: { minHeight: 48, justifyContent: "center" }, miniControls: { flexDirection: "row", alignItems: "center" },
  miniTitle: { color: colors.text, fontSize: 15, fontWeight: "700" }, onColorSecondary: { color: "#d0dbd5", fontSize: 13, lineHeight: 20 },
  miniBuffer: { ...StyleSheet.absoluteFill, backgroundColor: "#00000055", alignItems: "center", justifyContent: "center" },
  miniProgress: { position: "absolute", bottom: 0, left: 8, right: 8, height: 2, backgroundColor: "#ffffff33" },
  miniProgressFill: { height: 2, backgroundColor: colors.text }, action: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: 28 },
  largeAction: { width: 68, height: 68, backgroundColor: colors.text, borderRadius: 34 }, pressed: { opacity: 0.7 }, disabled: { opacity: 0.5 },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 }, full: { flex: 1, backgroundColor: colors.background },
  artworkClip: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 30, overflow: "hidden" },
  sharedArtwork: { position: "absolute", top: 0, left: 0 }, coverPress: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16 },
  headerDrag: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 48 }, headerTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  content: { flex: 1, paddingHorizontal: 28, width: "100%", maxWidth: 760, alignSelf: "center", gap: 12 },
  songContent: { flexGrow: 1, justifyContent: "center", gap: 20, paddingTop: 12, paddingBottom: 12 }, artworkDrag: { alignItems: "center", paddingVertical: 8 },
  metadataRow: { flexDirection: "row", gap: 12, alignItems: "center" }, metadata: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 27, lineHeight: 34, fontWeight: "800", letterSpacing: -0.5 },
  artist: { color: "#d0dbd5", fontSize: 16, lineHeight: 24 }, seek: { gap: 0 },
  times: { flexDirection: "row", justifyContent: "space-between" }, controls: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tools: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" },
  tool: { minHeight: 48, minWidth: 48, flexDirection: "row", gap: 8, alignItems: "center" }, toolText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  repeatHint: { color: "#d0dbd5", textAlign: "center", fontSize: 13 }, buffer: { flexDirection: "row", gap: 8, alignItems: "center" },
  panelHeader: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", paddingVertical: 16 }, back: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, minWidth: 48 },
  queue: { gap: 8, paddingBottom: 32 }, queueRow: { flexDirection: "row", gap: 8, alignItems: "center", minHeight: 64 }, queueText: { flex: 1, gap: 4 },
  compactControls: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12 },
  error: { color: "#ffbdb5", fontSize: 14, lineHeight: 20, paddingVertical: 8 }, startError: { paddingHorizontal: 20, paddingVertical: 12, backgroundColor: colors.surface },
});
