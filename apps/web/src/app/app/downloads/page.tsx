import { redirect } from "next/navigation";
import { legacyDownloadsHref } from "@/lib/app-routes";

export default async function LegacyDownloadsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") query.set(k, v);
  }
  redirect(legacyDownloadsHref(query));
}
