export interface DragSample { y: number; time: number }

export function recentVelocity(samples: DragSample[], now: number): number {
  const recent = samples.filter((sample) => now - sample.time <= 100);
  if (recent.length < 2) return 0;
  const first = recent[0]!, last = recent[recent.length - 1]!;
  return last.time > first.time ? (last.y - first.y) / (last.time - first.time) : 0;
}

export function settleExpanded(progress: number, velocity: number): boolean {
  "worklet";
  if (Math.abs(velocity) > 0.45) return velocity < 0;
  return progress > 0.5;
}

export function sheetDestination(progress: number, velocity: number, previous: boolean, cancelled: boolean): boolean {
  "worklet";
  return cancelled ? previous : settleExpanded(progress, velocity);
}

export function dragProgress(start: number, dy: number, height: number): number {
  "worklet";
  return Math.max(0, Math.min(1, start - dy / Math.max(1, height)));
}

export type DragAxis = "pending" | "horizontal" | "vertical" | "cancel";
export function dragAxis(dx: number, dy: number): DragAxis {
  "worklet";
  const x = Math.abs(dx), y = Math.abs(dy);
  if (Math.max(x, y) < 10) return "pending";
  if (x > y * 1.35) return "horizontal";
  if (y > x * 1.35) return "vertical";
  return Math.max(x, y) > 24 ? "cancel" : "pending";
}

export function swipeTrack(dx: number, velocityX: number, width: number): "next" | "previous" | null {
  "worklet";
  if (Math.abs(velocityX) >= 550) return velocityX < 0 ? "next" : "previous";
  if (Math.abs(dx) < Math.min(80, width * 0.22)) return null;
  return dx < 0 ? "next" : "previous";
}

export interface ArtworkFrame { x: number; y: number; size: number }
export function artworkTransform(mini: ArtworkFrame, full: ArtworkFrame, progress: number, canvasSize: number) {
  "worklet";
  const p = Math.max(0, Math.min(1, progress));
  const size = mini.size + (full.size - mini.size) * p;
  return {
    translateX: mini.x + (full.x - mini.x) * p - (canvasSize - size) / 2,
    translateY: mini.y + (full.y - mini.y) * p - (canvasSize - size) / 2,
    scale: size / Math.max(1, canvasSize),
  };
}
