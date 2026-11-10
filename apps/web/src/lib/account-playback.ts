import { DEVICE_ONLINE_MS } from "@mint/core/devices";

export interface AccountDeviceSnapshot {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string;
  state: {
    playing: boolean;
    trackId: string | null;
    time: number;
    duration: number;
    volume: number;
    shuffle: boolean;
    repeat: 0 | 1 | 2;
  };
}

/** Seconds to draw. Playing time moves between reports; a scrub holds the dragged position. */
export function shownPlaybackSeconds(report: { time: number; duration: number; playing: boolean; scrubbing: boolean; reportedAt: number }, now: number) {
  const held = report.scrubbing || !report.playing;
  const time = held ? report.time : report.time + Math.max(0, now - report.reportedAt) / 1000;
  return report.duration > 0 ? Math.min(report.duration, time) : time;
}

/** The other device this tab should display. A song playing here stays here. Otherwise follow a device that is actually playing, and keep that device after it pauses. Heartbeats from other paused devices do not take the player. */
export function chooseAccountPlayback<T extends { id: string; online: boolean; lastSeenAt: string; state: { playing: boolean; trackId: string | null } }>(
  devices: T[], localId: string | null, localPlaying: boolean, stickTo: string | null = null,
) {
  if (localPlaying) return null;
  const others = devices.filter((device) => device.online && device.id !== localId && device.state.trackId);
  const playing = others.filter((device) => device.state.playing);
  if (playing.length) {
    return playing.find((device) => device.id === stickTo) ?? [...playing].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0] ?? null;
  }
  return others.find((device) => device.id === stickTo) ?? null;
}

export function deviceIsOnline(reportedAt: number, now = Date.now()) {
  return now - reportedAt <= DEVICE_ONLINE_MS;
}
