export interface MobileTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  thumb?: string;
  duration?: number;
}

export interface QueueEntry extends MobileTrack {
  occurrenceId: string;
}

export type RepeatMode = "off" | "all" | "one";
export type { PlayerCollection } from "@mint/client";

export interface QueueContext {
  id: string;
  total: number;
  revision: number;
  offset: number;
  position: number;
  shuffle: boolean;
}

export interface QueuePage {
  context: QueueContext;
  items: (MobileTrack & { occurrenceId?: string; queueId?: string })[];
}

export interface PlayerState {
  track: QueueEntry | null;
  playing: boolean;
  loading: boolean;
  time: number;
  duration: number;
  queue: QueueEntry[];
  queueTotal: number;
  queueLoading: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  error: string | null;
}

export const emptyPlayerState: PlayerState = {
  track: null, playing: false, loading: false, time: 0, duration: 0,
  queue: [], queueTotal: 0, queueLoading: false, shuffle: false, repeat: "off", error: null,
};
