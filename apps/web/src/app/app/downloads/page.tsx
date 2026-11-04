import { requireUser } from "@/lib/auth";
import { Downloads } from "@/components/app/downloads";

export default async function DownloadsPage() {
  const user = await requireUser();
  return <Downloads memberId={user.id} />;
}
