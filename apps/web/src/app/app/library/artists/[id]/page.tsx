import type { Metadata } from "next";
import { MusicBrowser } from "@/components/app/music-browser";

export const metadata: Metadata = { title: "Artist" };

export default async function ArtistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MusicBrowser initialCollection={{ kind: "artist", id }} />;
}
