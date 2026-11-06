import { redirect } from "next/navigation";
import { legacyCollectionsHref } from "@/lib/app-routes";

export default async function LegacyCollectionsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") params.set(k, v);
  }
  redirect(legacyCollectionsHref(params));
}
