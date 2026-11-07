import { DetailScreen } from "../../src/screens/DetailScreen";
import { useLocalSearchParams } from "expo-router";
export default function AlbumRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DetailScreen key={id} kind="album" />;
}
