import { File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { fetch } from "expo/fetch";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { cachedPalette, neutralPalette, paletteFromColor, type ArtworkPalette } from "./palette";

export function artworkPalette(uri: string | undefined): Promise<ArtworkPalette> {
  if (!uri) return Promise.resolve(neutralPalette);
  return cachedPalette(uri, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const file = new File(Paths.cache, `mint-palette-${randomUUID()}.img`);
    let resized: File | null = null;
    let context: ReturnType<typeof ImageManipulator.manipulate> | null = null;
    let image: Awaited<ReturnType<ReturnType<typeof ImageManipulator.manipulate>["renderAsync"]>> | null = null;
    try {
      const response = await fetch(uri, { signal: controller.signal });
      if (!response.ok || !/^image\/(jpeg|png|webp|gif)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Artwork image unavailable.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Artwork streaming unavailable.");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 5 * 1024 * 1024) throw new Error("Artwork exceeds extraction budget.");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      await file.write(bytes);
      context = ImageManipulator.manipulate(file.uri);
      context.resize({ width: 32, height: 32 });
      image = await context.renderAsync();
      const result = await image.saveAsync({ format: SaveFormat.PNG });
      resized = new File(result.uri);
      const ImageColors = (await import("react-native-image-colors")).default;
      const colors = await ImageColors.getColors(result.uri, { cache: false, fallback: neutralPalette.primary });
      if (colors.platform === "android") return paletteFromColor(colors.vibrant || colors.dominant, colors.darkVibrant || colors.dominant);
      if (colors.platform === "ios") return paletteFromColor(colors.background || colors.primary, colors.secondary || colors.background);
      return paletteFromColor(colors.dominant);
    } finally {
      clearTimeout(timeout);
      image?.release();
      context?.release();
      if (file.exists) await file.delete();
      if (resized?.exists) await resized.delete();
    }
  });
}
