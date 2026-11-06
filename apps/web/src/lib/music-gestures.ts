type Point = { x: number; y: number };

export function createHoldGesture() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: Point | null = null;
  let held = false;
  const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; origin = null; };
  return {
    cancel,
    reset() { cancel(); held = false; },
    start(point: Point, open: () => void) {
      cancel(); held = false; origin = point;
      timer = setTimeout(() => { cancel(); held = true; open(); }, 550);
    },
    move(point: Point) { if (origin && Math.hypot(origin.x - point.x, origin.y - point.y) > 10) cancel(); },
    get held() { return held; },
    consumeClick() { const suppress = held; held = false; return suppress; },
  };
}
