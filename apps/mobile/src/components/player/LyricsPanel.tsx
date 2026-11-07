import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useApi } from "../../api";
import { usePlayer } from "../../playback/PlayerProvider";
import { activeLyric, parseLyrics, type LyricsResult } from "../../playback/lyrics";
import { colors } from "../../theme/tokens";

export function LyricsPanel() {
  const api = useApi(), player = usePlayer();
  const id = player.state.track?.id;
  const [result, setResult] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0), [following, setFollowing] = useState(true);
  const [reporting, setReporting] = useState(false), [message, setMessage] = useState(""), [sent, setSent] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const positions = useRef(new Map<number, number>());
  useEffect(() => {
    if (!id || !api) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(true); setResult(null); setError(null); setFollowing(true); setSent(false); setReporting(false);
    });
    positions.current.clear();
    void api.lyrics(id, controller.signal).then((response) => {
      if (!controller.signal.aborted) setResult(response);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Lyrics could not load.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, api, attempt]);
  const lyrics = result?.lyrics;
  const lines = parseLyrics(lyrics?.syncedLyrics ?? "");
  const time = player.state.time * 1000 - (result?.offsetMs ?? 0);
  const active = activeLyric(lines, time);
  useEffect(() => {
    if (following && active >= 0) scroll.current?.scrollTo({ y: Math.max(0, (positions.current.get(active) ?? 0) - 70), animated: true });
  }, [active, following]);
  async function report() {
    if (!api || !message.trim()) return;
    try {
      await api.reportIssue({ category: "lyrics", message: message.trim(), context: id ? `track:${id}` : null });
      setSent(true); setReporting(false); setMessage("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Your report could not be sent. Try again."); }
  }
  const wordTiming = lines.filter((line) => line.text).length > 0 && lines.filter((line) => line.text).every((line) => line.words?.length);
  return <View style={s.panel}>
    {loading ? <View style={s.center}><ActivityIndicator color={colors.text} /><Text style={s.secondary}>Loading lyrics</Text></View> :
      error ? <View style={s.center}><Text accessibilityLiveRegion="polite" style={s.secondary}>{error}</Text>
        <Pressable accessibilityRole="button" onPress={() => setAttempt((value) => value + 1)} style={s.button}><Text style={s.buttonText}>Try again</Text></Pressable></View> :
      lyrics?.instrumental ? <Text style={s.secondary}>This song is instrumental.</Text> :
      !lyrics ? <Text style={s.secondary}>{"Lyrics aren't available for this song yet."}</Text> :
      <><View style={s.timing}><Text style={s.secondary}>{lyrics.source ?? "Lyrics"} · {wordTiming ? "Word timing" : lines.length ? "Line timing" : "Plain lyrics"}</Text>
        {!following && lines.length ? <Pressable accessibilityRole="button" onPress={() => setFollowing(true)} style={s.button}><Text style={s.buttonText}>Follow song</Text></Pressable> : null}</View>
        <ScrollView ref={scroll} style={s.scroll} contentContainerStyle={s.lyrics} onScrollBeginDrag={() => setFollowing(false)}>
          {lines.length ? lines.map((line, index) => <Pressable key={`${line.time}-${index}`} accessibilityRole="button"
            accessibilityLabel={`Seek to lyric: ${line.text}`} onLayout={(event) => positions.current.set(index, event.nativeEvent.layout.y)}
            onPress={() => { void player.seek((line.time + (result?.offsetMs ?? 0)) / 1000).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not seek.")); }}
            style={s.line}>
            <Text style={[s.lyric, index === active && s.active]}>{line.words?.length && index === active
              ? line.words.map((word, wordIndex) => <Text key={wordIndex} style={word.time <= time ? s.active : s.futureWord}>{word.text}</Text>)
              : line.text || " "}</Text>
          </Pressable>) : <Text style={s.plain}>{lyrics.plainLyrics || "Lyrics aren't available for this song yet."}</Text>}
        </ScrollView></>}
    {sent ? <Text accessibilityLiveRegion="polite" style={s.secondary}>Your lyrics report was sent.</Text> :
      reporting ? <View style={s.report}><TextInput accessibilityLabel="Describe the lyrics problem" value={message} onChangeText={setMessage}
        multiline maxLength={2000} placeholder="What needs correcting?" placeholderTextColor="#d0dbd5" style={s.input} />
        <View style={s.timing}><Pressable accessibilityRole="button" onPress={() => void report()} disabled={!message.trim()} style={s.button}>
          <Text style={s.buttonText}>Send report</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => setReporting(false)} style={s.button}><Text style={s.buttonText}>Cancel</Text></Pressable></View></View> :
      <Pressable accessibilityRole="button" onPress={() => setReporting(true)} style={s.button}><Text style={s.buttonText}>Report a lyrics problem</Text></Pressable>}
  </View>;
}

const s = StyleSheet.create({
  panel: { flex: 1, minHeight: 160, gap: 12 }, center: { paddingVertical: 32, gap: 16, alignItems: "flex-start" },
  secondary: { color: "#d0dbd5", fontSize: 14, lineHeight: 22 }, timing: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
  scroll: { flex: 1 }, lyrics: { paddingBottom: 48 }, line: { minHeight: 44, paddingVertical: 12 },
  lyric: { color: "#c5d2cc", fontSize: 27, fontWeight: "700", lineHeight: 36 }, active: { color: "#ffffff" }, futureWord: { color: "#c5d2cc" },
  plain: { color: colors.text, fontSize: 24, fontWeight: "600", lineHeight: 36 },
  button: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: 8 },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  report: { gap: 8 }, input: { color: colors.text, borderColor: "#c5d2cc", borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 88 },
});
