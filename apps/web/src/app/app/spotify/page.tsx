import { redirect } from "next/navigation";
import { legacySpotifyHref } from "@/lib/app-routes";

export default async function LegacySpotifyRedirect({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; linked?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  if (sp.error) query.set("error", sp.error);
  if (sp.linked) query.set("linked", sp.linked);
  if (sp.page) query.set("page", sp.page);
  redirect(legacySpotifyHref(query));
}
