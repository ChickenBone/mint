export const neutralPalette = { primary: "#303a40", secondary: "#192125", bottom: "#111314" } as const;
export interface ArtworkPalette { primary: string; secondary: string; bottom: string }

export function readableColor(color: string): string {
  if (!/^#[\da-f]{6}$/i.test(color)) return neutralPalette.primary;
  const channels = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
  const luminance = () => channels.map((value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  while (luminance() > 0.1) for (let i = 0; i < 3; i++) channels[i] = Math.floor(channels[i]! * 0.94);
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function paletteFromColor(primary: string, secondary?: string): ArtworkPalette {
  return { primary: readableColor(primary), secondary: readableColor(secondary ?? primary), bottom: neutralPalette.bottom };
}

export function prominentPixelColor(pixels: Uint8ClampedArray): string {
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3]! < 128) continue;
    const [r, g, b] = [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
    const key = (r >> 4) << 8 | (g >> 4) << 4 | b >> 4;
    const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bin.count++; bin.r += r; bin.g += g; bin.b += b;
    bins.set(key, bin);
  }
  let best: { count: number; r: number; g: number; b: number } | undefined;
  let bestScore = -1;
  for (const bin of bins.values()) {
    const values = [bin.r, bin.g, bin.b].map((value) => value / bin.count);
    const saturation = (Math.max(...values) - Math.min(...values)) / Math.max(1, Math.max(...values));
    const score = bin.count * (0.65 + saturation);
    if (score > bestScore) { best = bin; bestScore = score; }
  }
  if (!best) return neutralPalette.primary;
  return `#${[best.r, best.g, best.b].map((value) => Math.round(value / best!.count).toString(16).padStart(2, "0")).join("")}`;
}

const cache = new Map<string, { palette: ArtworkPalette; expires: number }>();
const pending = new Map<string, Promise<ArtworkPalette>>();
export async function cachedPalette(key: string, extract: () => Promise<ArtworkPalette>): Promise<ArtworkPalette> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    cache.delete(key); cache.set(key, hit);
    return hit.palette;
  }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  if (pending.size >= 2) return neutralPalette;
  const job = extract().then((palette) => {
    cache.set(key, { palette, expires: Date.now() + 3600_000 });
    return palette;
  }).catch((error: unknown) => {
    console.warn("Artwork color extraction unavailable", error instanceof Error ? error.message : "Unknown image error");
    cache.set(key, { palette: neutralPalette, expires: Date.now() + 60_000 });
    return neutralPalette;
  }).finally(() => {
    pending.delete(key);
    while (cache.size > 64) cache.delete(cache.keys().next().value!);
  });
  pending.set(key, job);
  return job;
}
