import { redirect } from "next/navigation";
import { legacyManageHref } from "@/lib/app-routes";
import { requireAdmin } from "@/lib/auth";

export default async function LegacyAnalysisPage() {
  await requireAdmin();
  redirect(legacyManageHref("analysis", true));
}
