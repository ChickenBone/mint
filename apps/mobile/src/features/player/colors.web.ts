import { cachedPalette, neutralPalette, paletteFromColor, prominentPixelColor, type ArtworkPalette } from "./palette";

export function artworkPalette(uri: string | undefined): Promise<ArtworkPalette> {
  if (!uri || typeof document === "undefined") return Promise.resolve(neutralPalette);
  return cachedPalette(uri, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let objectUrl: string | null = null;
    try {
      const response = await fetch(uri, { signal: controller.signal, mode: "cors" });
      if (!response.ok || !/^image\/(jpeg|png|webp|gif)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Artwork image unavailable.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Artwork streaming unavailable.");
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 5 * 1024 * 1024) throw new Error("Artwork exceeds extraction budget.");
          chunks.push(new Uint8Array(value));
        }
      } finally { await reader.cancel(); }
      objectUrl = URL.createObjectURL(new Blob(chunks, { type: response.headers.get("content-type")! }));
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Artwork color canvas unavailable.");
      context.drawImage(image, 0, 0, 32, 32);
      return paletteFromColor(prominentPixelColor(context.getImageData(0, 0, 32, 32).data));
    } finally {
      clearTimeout(timeout);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  });
}
