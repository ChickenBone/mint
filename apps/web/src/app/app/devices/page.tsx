import { redirect } from "next/navigation";
import { legacyDevicesHref } from "@/lib/app-routes";

export default function LegacyDevicesRedirect() {
  redirect(legacyDevicesHref());
}
