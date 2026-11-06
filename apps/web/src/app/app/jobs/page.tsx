import { redirect } from "next/navigation";
import { legacyManageHref } from "@/lib/app-routes";
import { requireUser } from "@/lib/auth";

export default async function LegacyJobsPage() {
  const user = await requireUser();
  redirect(legacyManageHref("jobs", user.role === "admin"));
}
