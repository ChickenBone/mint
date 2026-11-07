import { DetailScreen } from "../../src/screens/DetailScreen";
import { useLocalSearchParams } from "expo-router";
export default function CollectionRoute() {
  const { id, source } = useLocalSearchParams<{ id: string; source?: string }>();
  return <DetailScreen key={`${id}:${source ?? "native"}`} kind="playlist" />;
}
