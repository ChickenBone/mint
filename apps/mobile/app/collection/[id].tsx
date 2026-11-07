import { PlaylistScreen } from "../../src/features/playlists/PlaylistScreen";
import { useLocalSearchParams } from "expo-router";
export default function CollectionRoute() {
  const { id, source } = useLocalSearchParams<{ id: string; source?: string }>();
  return <PlaylistScreen key={`${id}:${source ?? "native"}`} />;
}
