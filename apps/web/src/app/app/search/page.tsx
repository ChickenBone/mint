import type { Metadata } from "next";
import { GlobalSearch } from "@/components/app/global-search";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <GlobalSearch fullPage initialQuery={typeof q === "string" ? q.slice(0, 100) : ""} />;
}
