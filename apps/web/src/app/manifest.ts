import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/", name: "Mint Music", short_name: "Mint", description: "Your music library, wherever you listen.",
    start_url: "/app/music", scope: "/", display: "standalone", background_color: "#0a0d0c", theme_color: "#0a0d0c",
    orientation: "any", prefer_related_applications: false,
    icons: [192, 512].flatMap((size) => [
      { src: `/api/app-icon/${size}`, sizes: `${size}x${size}`, type: "image/png", purpose: "any" as const },
      { src: `/api/app-icon/${size}`, sizes: `${size}x${size}`, type: "image/png", purpose: "maskable" as const },
    ]),
    shortcuts: [{ name: "Your library", url: "/app/library" }, { name: "Liked songs", url: "/app/liked" }],
  };
}
