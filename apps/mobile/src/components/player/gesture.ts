export interface DragSample { y: number; time: number }

export function recentVelocity(samples: DragSample[], now: number): number {
  const recent = samples.filter((sample) => now - sample.time <= 100);
  if (recent.length < 2) return 0;
  const first = recent[0]!, last = recent[recent.length - 1]!;
  return last.time > first.time ? (last.y - first.y) / (last.time - first.time) : 0;
}

export function settleExpanded(progress: number, velocity: number): boolean {
  if (Math.abs(velocity) > 0.45) return velocity < 0;
  return progress > 0.5;
}

export function dragProgress(start: number, dy: number, height: number): number {
  return Math.max(0, Math.min(1, start - dy / Math.max(1, height)));
}
