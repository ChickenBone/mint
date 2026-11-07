export interface PlayerSheetSample {
  y: number;
  time: number;
}

export interface PlayerSheetSpring {
  position: number;
  velocity: number;
}

export function playerSheetProgress(start: number, startY: number, y: number, travel: number) {
  if (travel <= 0) return start;
  return resistPlayerSheetProgress(start + (startY - y) / travel);
}

export function resistPlayerSheetProgress(progress: number) {
  if (progress < 0) return progress / (1 + Math.abs(progress) * 5);
  if (progress > 1) return 1 + (progress - 1) / (1 + (progress - 1) * 5);
  return progress;
}

export function playerSheetReleaseVelocity(samples: PlayerSheetSample[], travel: number, now: number) {
  if (travel <= 0 || samples.length < 2) return 0;
  const recent = samples.filter((sample) => now - sample.time <= 120);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || now - last.time > 90) return 0;

  const elapsed = last.time - first.time;
  const distance = last.y - first.y;
  if (elapsed < 12 || Math.abs(distance) < 4) return 0;
  return -distance / elapsed * 1000 / travel;
}

export function playerSheetDestination(progress: number, velocity: number) {
  if (velocity > 0.72) return 1;
  if (velocity < -0.72) return 0;
  return progress >= 0.5 ? 1 : 0;
}

export function stepPlayerSheetSpring(state: PlayerSheetSpring, target: number, elapsedMs: number): PlayerSheetSpring {
  const elapsed = Math.min(Math.max(elapsedMs, 0), 32) / 1000;
  const acceleration = 360 * (target - state.position) - 38 * state.velocity;
  const velocity = state.velocity + acceleration * elapsed;
  return { position: state.position + velocity * elapsed, velocity };
}
