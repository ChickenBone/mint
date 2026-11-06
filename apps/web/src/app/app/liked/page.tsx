import { redirect } from "next/navigation";
import { legacyLikedHref } from "@/lib/app-routes";

export default function LegacyLikedRedirect() {
  redirect(legacyLikedHref());
}
