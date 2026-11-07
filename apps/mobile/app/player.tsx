import { useEffect } from "react";
import { usePlayer } from "../src/playback/PlayerProvider";
import { HomeScreen } from "../src/screens/HomeScreen";

export default function PlayerRoute() {
  const { open } = usePlayer();
  useEffect(() => { open(); }, [open]);
  return <HomeScreen />;
}
