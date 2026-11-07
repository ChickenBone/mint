import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useApi } from "../api";
import { Button, Notice, Section } from "../components/ui/primitives";
import { MusicShelf } from "../components/ui/music";
import { PageTitle } from "../components/ui/PageTitle";
import { useResource } from "../hooks/useResource";
import { colors } from "../theme/tokens";
import { greeting } from "./navigation";

export function HomeScreen() {
  const api = useApi();
  const home = useResource(async (signal) => {
    if (!api) throw new Error("Sign in to load your music.");
    const [personal, recent, rediscover, albums] = await Promise.all([
      api.discover("for-you", signal), api.discover("recent", signal), api.discover("rediscover", signal),
      api.catalog({ type: "album", size: 18, sort: "newest" }, signal),
    ]);
    return { personal, recent, rediscover, albums };
  }, [api]);
  return <ScrollView contentContainerStyle={s.page}>
    <PageTitle title={greeting(new Date().getHours())} />
    <View style={s.shortcuts}><Button label="Liked songs" quiet icon="heart" onPress={() => router.push("/collection/liked")} />
      <Button label="Your playlists" quiet icon="library" onPress={() => router.navigate("/library")} /></View>
    {home.loading ? <Notice loading title="Finding your next listen" /> : home.error ? <Notice title="Couldn't load Home" message={home.error} retry={home.reload} /> : home.data ? <>
      {home.data.personal.items.length ? <Section title="Made for your listening"><MusicShelf items={home.data.personal.items.map((entry) => entry.item)} /></Section> : null}
      {home.data.albums.items.length ? <Section title="Albums to get into"><MusicShelf items={home.data.albums.items} /></Section> : null}
      {home.data.recent.items.length ? <Section title="New in your library"><MusicShelf items={home.data.recent.items.map((entry) => entry.item)} /></Section> : null}
      {home.data.rediscover.items.length ? <Section title="Worth another listen"><MusicShelf items={home.data.rediscover.items.map((entry) => entry.item)} /></Section> : null}
      {!home.data.personal.items.length && !home.data.albums.items.length && !home.data.recent.items.length ?
        <Notice title="Make yourself at home" message="Find an artist, album, or song in Search. Like the songs you love to make this space yours." /> : null}
    </> : null}
  </ScrollView>;
}

export const screenStyles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingBottom: 32, maxWidth: 1440, width: "100%", alignSelf: "center" },
  heading: { color: colors.text, fontSize: 32, fontWeight: "800", letterSpacing: -.7, marginTop: 8, marginBottom: 20 },
  shortcuts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
const s = screenStyles;
