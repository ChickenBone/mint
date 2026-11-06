import type { Metadata } from "next";
import { GlobalSearch } from "@/components/app/global-search";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage() {
  return <GlobalSearch />;
}
