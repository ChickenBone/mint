import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE, sha256 } from "@mint/core/crypto";
import { getDb } from "@mint/core/db";
import { PageHeader } from "@/components/app/page-header";
import { DevicesPanel } from "@/components/app/devices-panel";
import { requireUser } from "@/lib/auth";
import { DeviceStore } from "@/lib/devices-store";

export const metadata: Metadata = { title: "Devices & parties" };
export const dynamic = "force-dynamic";
export default async function DevicesPage() {
  const user = await requireUser();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const store = new DeviceStore(getDb(), { userId: user.id, sessionId: sha256(cookie!) });
  const [devices, parties] = await Promise.all([store.list(), store.listParties()]);
  return (
    <>
      <PageHeader title="Devices & parties" sub={<p className="max-w-2xl">Your music, on the device you choose. Keep Mint open and connected; a closed browser cannot be woken remotely.</p>} />
      <DevicesPanel initialDevices={devices} initialParties={parties} />
    </>
  );
}
