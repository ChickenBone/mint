import { useEffect } from "react";
import { usePlayer } from "../../playback/PlayerProvider";
import { HomeScreen } from "../home/HomeScreen";

export function PlayerScreen() {
  const { open } = usePlayer();
  useEffect(() => { open(); }, [open]);
  return <HomeScreen />;
}
