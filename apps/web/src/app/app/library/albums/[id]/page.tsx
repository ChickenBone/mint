import type { Metadata } from "next";
import { MusicBrowser } from "@/components/app/music-browser";

export const metadata: Metadata = { title: "Album" };

export default async function AlbumPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MusicBrowser initialCollection={{ kind: "album", id }} />;
}
