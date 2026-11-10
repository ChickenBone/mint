"use client";

import { useEffect, useState } from "react";
import type { PlaybackView } from "@mint/core/events";
import { useRealtime } from "@/components/realtime";
import {
  chooseAccountPlayback, deviceIsOnline, shownPlaybackSeconds,
  type AccountDeviceSnapshot,
} from "@/lib/account-playback";
import { controlDevice, getLocalDeviceId, listConnectableDevices, previewDevicePosition } from "@/lib/device-client";
import { playerItemSchema, type PlayerCommand, type PlayerItem, type PlayerState } from "@/lib/player-protocol";

export interface AccountPlayback {
  deviceId: string;
  deviceName: string;
  here: boolean;
  state: PlayerState;
  scrubMs: number | null;
  control: (command: PlayerCommand) => Promise<boolean>;
  preview: (milliseconds: number | null) => void;
}

interface Report {
  id: string;
  name: string;
  playing: boolean;
  time: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: 0 | 1 | 2;
  trackId: string | null;
  scrubbing: boolean;
  reportedAt: number;
}

function snapshotReport(device: AccountDeviceSnapshot): Report {
  return {
    id: device.id, name: device.name, playing: device.state.playing, time: device.state.time, duration: device.state.duration,
    volume: device.state.volume, shuffle: device.state.shuffle, repeat: device.state.repeat, trackId: device.state.trackId,
    scrubbing: false, reportedAt: Date.parse(device.lastSeenAt),
  };
}

function eventReport(event: PlaybackView): Report {
  return {
    id: event.deviceId, name: event.deviceName, playing: event.playing, time: event.time, duration: event.duration,
    volume: event.volume, shuffle: event.shuffle, repeat: event.repeat, trackId: event.trackId, scrubbing: event.scrubbing,
    reportedAt: Date.parse(event.reportedAt),
  };
}

export function useAccountPlayback(localPlaying: boolean, localTimeMs = 0): AccountPlayback | null {
  const [reports, setReports] = useState<Report[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [localId, setLocalId] = useState<string | null>(null);
  const [loadedTrack, setLoadedTrack] = useState<{ id: string; item: PlayerItem } | null>(null);
  const [pin, setPin] = useState<{ id: string; ms: number; at: number } | null>(null);
  const [stickTo, setStickTo] = useState<string | null>(null);
  const devices = reports.filter((report) => deviceIsOnline(report.reportedAt, now)).map((report) => ({
    id: report.id, name: report.name, online: true, lastSeenAt: new Date(report.reportedAt).toISOString(),
    state: { playing: report.playing, trackId: report.trackId, time: report.time, duration: report.duration, volume: report.volume, shuffle: report.shuffle, repeat: report.repeat },
  }));
  const chosen = chooseAccountPlayback(devices, localId, localPlaying, stickTo);
  const nextStickTo = localPlaying ? null : chosen?.id ?? null;
  if (stickTo !== nextStickTo) setStickTo(nextStickTo);
  const report = reports.find((item) => item.id === (localPlaying ? localId : chosen?.id));
  const trackId = report?.trackId ?? null;
  const track = loadedTrack?.id === trackId ? loadedTrack.item : null;

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setLocalId(getLocalDeviceId());
      void listConnectableDevices().then((rows) => {
        if (cancelled) return;
        setReports((current) => {
          const next = new Map(current.map((item) => [item.id, item]));
          for (const row of rows as unknown as AccountDeviceSnapshot[]) {
            const seeded = snapshotReport(row);
            const existing = next.get(row.id);
            if (existing?.scrubbing && Date.now() - existing.reportedAt < 2000) continue;
            if (!existing || seeded.reportedAt >= existing.reportedAt) next.set(row.id, seeded);
          }
          return [...next.values()];
        });
      }).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useRealtime((event) => {
    if (event.type !== "playback") return;
    const next = eventReport(event.data);
    if (!Number.isFinite(next.reportedAt)) return;
    const receivedAt = Date.now();
    setReports((current) => {
      const without = current.filter((item) => item.id !== next.id);
      return [...without, next];
    });
    setNow(receivedAt);
    if (next.scrubbing) setPin({ id: next.id, ms: next.time * 1000, at: receivedAt });
  });

  useEffect(() => {
    if (!report?.playing || report.scrubbing) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [report?.playing, report?.scrubbing, report?.id]);

  useEffect(() => {
    if (!trackId) return;
    let cancelled = false;
    void fetch("/api/player/items", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [trackId] }),
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok || cancelled) return;
      const parsed = playerItemSchema.safeParse(body.items?.[0]);
      if (parsed.success) setLoadedTrack({ id: trackId, item: parsed.data });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [trackId]);

  if (!report || !trackId) return null;
  const here = report.id === localId;
  if (!here && !chosen) return null;
  const seconds = shownPlaybackSeconds(report, now);
  const scrubbing = report.scrubbing && now - report.reportedAt < 1500;
  const held = pin?.id === report.id && now - pin.at < 4000 && Math.abs(localTimeMs - pin.ms) > 1500
    ? pin.ms : null;
  const state: PlayerState = {
    playing: report.playing, time: seconds * 1000, duration: report.duration * 1000, volume: report.volume,
    shuffle: report.shuffle, repeat: report.repeat, track, queue: [], queueTotal: 0, queueOffset: 0,
  };
  return {
    deviceId: report.id,
    deviceName: report.name,
    here,
    state,
    scrubMs: scrubbing ? seconds * 1000 : here ? held : null,
    preview: (milliseconds) => previewDevicePosition(report.id, milliseconds === null ? null : milliseconds / 1000),
    control: async (command) => {
      try {
        if (command.action === "toggle") await controlDevice(report.id, report.playing ? "pause" : "play");
        else if (command.action === "pause" || command.action === "resume") await controlDevice(report.id, command.action === "resume" ? "play" : "pause");
        else if (command.action === "next" || command.action === "previous") await controlDevice(report.id, command.action);
        else if (command.action === "seek") await controlDevice(report.id, "seek", command.value / 1000);
        else if (command.action === "volume") await controlDevice(report.id, "volume", command.value);
        else return false;
        return true;
      } catch {
        return false;
      }
    },
  };
}
