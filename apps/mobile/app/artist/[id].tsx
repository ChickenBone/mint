import { ArtistScreen } from "../../src/features/artists/ArtistScreen";
import { useLocalSearchParams } from "expo-router";
export default function ArtistRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ArtistScreen key={id} />;
}
