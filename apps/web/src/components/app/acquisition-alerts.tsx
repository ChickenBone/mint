"use client";

import { useRef } from "react";
import { useRealtime } from "@/components/realtime";
import { useToast } from "@/components/ui/toast";

/** Tells the member when a background match or import fails, from any page. */
export function AcquisitionAlerts() {
  const { showToast } = useToast();
  const seen = useRef(new Set<string>());
  useRealtime((event) => {
    if (event.type !== "track" || event.data.stage !== "failed") return;
    const key = `${event.data.id}:${event.data.updatedAt}:${event.data.detail ?? ""}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    const song = `${event.data.title} by ${event.data.artist}`;
    showToast(`${song} was not added. ${event.data.detail ?? "Open Jobs to review it."}`, "error");
  });
  return null;
}
