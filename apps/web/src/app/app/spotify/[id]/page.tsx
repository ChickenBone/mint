import { redirect } from "next/navigation";
import { legacyCollectionDetailHref } from "@/lib/app-routes";

export default async function LegacySpotifyPlaylistDetailRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const query = new URLSearchParams();
  if (sp.page) query.set("page", sp.page);
  redirect(legacyCollectionDetailHref(id, query));
}
