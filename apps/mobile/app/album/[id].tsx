import { AlbumScreen } from "../../src/features/albums/AlbumScreen";
import { useLocalSearchParams } from "expo-router";
export default function AlbumRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AlbumScreen key={id} />;
}
