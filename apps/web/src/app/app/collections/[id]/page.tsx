import { redirect } from "next/navigation";
import { legacyCollectionDetailHref } from "@/lib/app-routes";

export default async function LegacyCollectionDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(legacyCollectionDetailHref(id));
}
