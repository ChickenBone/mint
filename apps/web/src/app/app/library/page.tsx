import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MusicBrowser } from "@/components/app/music-browser";
import { legacyLibraryHref } from "@/lib/app-routes";

export const metadata: Metadata = { title: "Library" };

export default async function Library({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const values = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") params.set(key, value);
    else value?.forEach((item) => params.append(key, item));
  }
  const canonical = legacyLibraryHref(params);
  if (canonical !== `/app/library${params.size ? `?${params}` : ""}`) redirect(canonical);
  return <MusicBrowser />;
}
