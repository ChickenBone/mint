import type { Metadata } from "next";
import { ManageView } from "@/components/app/manage-view";
import { getDb } from "@mint/core/db";
import { requireAdmin } from "@/lib/auth";
import {
  getAccessRequests,
  getActiveTracks,
  getAllWorkers,
  getFailedTracks,
  getHealth,
  getMembers,
  getMyWorkers,
  getRemotePoolSize,
} from "@/lib/data";
import { listIssueReports } from "@/lib/issue-reports";
import { publicUrl } from "@/lib/request";

export const metadata: Metadata = { title: "Admin portal" };
export const dynamic = "force-dynamic";

export default async function ManagePage() {
  const admin = await requireAdmin();
  const [
    requests,
    members,
    failedTracks,
    activeTracks,
    health,
    allWorkers,
    myWorkers,
    remotePoolSize,
    issueReports,
  ] = await Promise.all([
    getAccessRequests(),
    getMembers(),
    getFailedTracks(),
    getActiveTracks(),
    getHealth(),
    getAllWorkers(),
    getMyWorkers(admin.id),
    getRemotePoolSize(),
    listIssueReports(getDb()),
  ]);

  return (
    <ManageView
      adminId={admin.id}
      origin={publicUrl()}
      requests={requests.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        requestNote: r.requestNote,
        createdAt: r.createdAt.toISOString(),
      }))}
      members={members}
      failedTracks={failedTracks}
      activeTracks={activeTracks}
      health={health}
      allWorkers={allWorkers}
      myWorkers={myWorkers}
      remotePoolSize={remotePoolSize}
      issueReports={issueReports}
    />
  );
}
