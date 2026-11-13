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
import { targetAuthentication, targetAuthenticationEnabled } from "@/lib/target-auth";
import { targetManageAccounts } from "@/lib/app-routes";

export const metadata: Metadata = { title: "Admin portal" };
export const dynamic = "force-dynamic";

export default async function ManagePage({ searchParams }: {
  searchParams: Promise<{ requestsCursor?: string | string[]; membersCursor?: string | string[] }>;
}) {
  const admin = await requireAdmin();
  const target = targetAuthenticationEnabled();
  const params = await searchParams;
  if (Array.isArray(params.requestsCursor) || Array.isArray(params.membersCursor)) {
    throw new Error("Invalid account page.");
  }
  const { requestsCursor, membersCursor } = params;
  const accounts = target
    ? (async () => {
        const { sdk, signal } = await targetAuthentication();
        const [requests, members] = await Promise.all([
          sdk.accounts.listAccounts({ status: "pending", limit: 50, cursor: requestsCursor }, { signal }),
          sdk.accounts.listAccounts({ status: "members", limit: 50, cursor: membersCursor }, { signal }),
        ]);
        return targetManageAccounts(requests, members, requestsCursor, membersCursor);
      })()
    : Promise.all([getAccessRequests(), getMembers()]).then(([requests, members]) => ({
        requests: requests.map(({ id, name, email, requestNote, createdAt }) =>
          ({ id, name, email, requestNote, createdAt: createdAt.toISOString() })),
        members,
        pagination: null,
      }));
  const [
    accountData,
    failedTracks,
    activeTracks,
    health,
    allWorkers,
    myWorkers,
    remotePoolSize,
    issueReports,
  ] = await Promise.all([
    accounts,
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
      requests={accountData.requests}
      members={accountData.members}
      accountPagination={accountData.pagination}
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
