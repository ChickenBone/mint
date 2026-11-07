import { router } from "expo-router";
import { ScrollView, View } from "react-native";
import { useApi } from "../../api";
import { Button, Notice, Section } from "../../components/ui/primitives";
import { MusicShelf } from "../../components/ui/music";
import { PageTitle } from "../../components/ui/PageTitle";
import { screenStyles } from "../../components/music/screen-styles";
import { useResource } from "../../hooks/useResource";
import { greeting, loadHome } from "./home-model";

export function HomeScreen() {
  const api = useApi();
  const home = useResource((signal) => loadHome(api, signal), [api]);
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

const s = screenStyles;
