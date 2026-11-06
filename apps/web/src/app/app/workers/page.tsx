import { redirect } from "next/navigation";
import { legacyManageHref } from "@/lib/app-routes";
import { requireUser } from "@/lib/auth";

export default async function LegacyWorkersPage() {
  const user = await requireUser();
  redirect(legacyManageHref("workers", user.role === "admin"));
}
