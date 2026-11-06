"use client";

import { usePlayer } from "./player";
import { AudioPanel } from "./player-panels";

export function PlaybackSettings() {
  const player = usePlayer();
  return <section id="playback" className="scroll-mt-6 border-t border-line py-8">
    <h2 className="text-2xl font-bold">Playback & sound</h2>
    <p className="mb-7 mt-2 max-w-2xl text-sm text-muted">Make it sound like you. Equalizer, normalization and transitions are saved for your account on this device.</p>
    {player?.ready ? <AudioPanel state={player.state} command={player.command} showPlayback={false} />
      : <p role="status" className="text-sm text-muted">Starting audio settings…</p>}
  </section>;
}
