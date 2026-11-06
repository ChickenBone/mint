"use client";

import { useEffect, useState, type HTMLAttributes } from "react";
import type { PlayerItem } from "@/lib/player-protocol";
import { createHoldGesture } from "@/lib/music-gestures";
import { usePlayer } from "./player";

/** One gesture contract for songs, sleeves and queue entries. */
export function MusicItem({ item, as: Element = "div", children, ...props }: {
  item: PlayerItem | null; as?: "div" | "li" | "article"; children: React.ReactNode;
} & HTMLAttributes<HTMLElement>) {
  const player = usePlayer();
  const [hold] = useState(createHoldGesture);
  useEffect(() => () => hold.cancel(), [hold]);
  const open = (element: HTMLElement, x: number, y: number) => {
    if (item && player) player.menu(item, { x, y }, element.querySelector<HTMLElement>("button,a,[tabindex]") ?? element);
  };
  return <Element {...props}
    onContextMenu={(event) => {
      if (!item || !player || (event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) return;
      event.preventDefault(); event.stopPropagation(); hold.cancel();
      if (!hold.held) open(event.currentTarget, event.clientX, event.clientY);
    }}
    onKeyDown={(event) => {
      if (!item || !player || (event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]") ||
        !(event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) return;
      event.preventDefault(); event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      player.menu(item, { x: rect.left + 24, y: rect.bottom }, event.target as HTMLElement);
    }}
    onPointerDown={(event) => {
      hold.reset();
      if (!item || !player || event.pointerType === "mouse" || !event.isPrimary ||
        (event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) return;
      const element = event.currentTarget, point = { x: event.clientX, y: event.clientY };
      hold.start(point, () => open(element, point.x, point.y));
    }}
    onPointerMove={(event) => hold.move({ x: event.clientX, y: event.clientY })}
    onPointerUp={hold.cancel} onPointerCancel={hold.cancel} onTouchMove={hold.cancel}
    onClickCapture={(event) => { if (hold.consumeClick()) { event.preventDefault(); event.stopPropagation(); } }}
    className={`${item && player ? "music-item " : ""}${props.className ?? ""}`}>{children}</Element>;
}
