import { redirect } from "next/navigation";
import { legacyHistoryHref } from "@/lib/app-routes";

export default function LegacyHistoryRedirect() {
  redirect(legacyHistoryHref());
}
