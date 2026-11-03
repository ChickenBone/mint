import type { Metadata } from "next";
import { decideRequest, retryAllFailed, setMemberRole, setMemberStatus } from "@/app/actions/admin";
import { ActionButton } from "@/components/app/admin-controls";
import { LiveTrackList } from "@/components/app/live-track-list";
import { PageHeader } from "@/components/app/page-header";
import { requireAdmin } from "@/lib/auth";
import { getAccessRequests, getFailedTracks, getHealth, getMembers } from "@/lib/data";
import { formatCount, timeAgo } from "@/lib/format";
import clsx from "clsx";

export const metadata: Metadata = { title: "Admin" };

const SERVICE_LABEL = { lidarr: "Lidarr", torbox: "TorBox", cobalt: "Cobalt", plex: "Plex" } as const;

export default async function Admin() {
  const admin = await requireAdmin();
  const [requests, members, failed, health] = await Promise.all([getAccessRequests(), getMembers(), getFailedTracks(), getHealth()]);

  return (
    <>
      <PageHeader title="Admin" sub="Requests, members and the health of everything behind the wall." />

      <section className="mb-12">
        <h2 className="mb-4 text-xl font-bold">Access requests {requests.length > 0 && <span className="text-mint tabular">({requests.length})</span>}</h2>
        {requests.length === 0 ? (
          <p className="text-muted">No one is waiting. New requests show up here live.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl bg-elevated">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {r.name} <span className="font-normal text-muted">{r.email}</span>
                  </p>
                  {r.requestNote && <p className="mt-1 max-w-xl text-sm text-muted">&ldquo;{r.requestNote}&rdquo;</p>}
                  <p className="mt-1 text-xs text-faint">Asked {timeAgo(r.createdAt)}</p>
                </div>
                <div className="flex gap-2">
                  <ActionButton action={decideRequest.bind(null, r.id, false)} tone="danger">Deny</ActionButton>
                  <ActionButton action={decideRequest.bind(null, r.id, true)} tone="primary">Approve</ActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-12">
        <h2 className="mb-1 text-xl font-bold">Services</h2>
        <p className="mb-4 text-sm text-muted">{health ? `Checked ${timeAgo(health.checkedAt)} by the worker.` : "The worker hasn't reported yet. Is it running?"}</p>
        {health && (
          <div className="grid gap-8 md:grid-cols-[16rem_1fr]">
            <ul className="flex flex-col gap-2">
              {(Object.keys(SERVICE_LABEL) as Array<keyof typeof SERVICE_LABEL>).map((k) => {
                const ok = health.services[k];
                return (
                  <li key={k} className="flex items-center justify-between">
                    <span className="font-medium">{SERVICE_LABEL[k]}</span>
                    <span className={clsx("inline-flex items-center gap-1.5 text-sm", ok === null ? "text-faint" : ok ? "text-mint" : "text-danger")}>
                      <span className="size-2 rounded-full bg-current" aria-hidden />
                      {ok === null ? "Not configured" : ok ? "Reachable" : "Down"}
                    </span>
                  </li>
                );
              })}
            </ul>
            <table className="w-full text-sm tabular">
              <thead className="text-left text-faint">
                <tr>
                  <th className="pb-2 font-medium">Queue</th>
                  <th className="pb-2 text-right font-medium">Active</th>
                  <th className="pb-2 text-right font-medium">Waiting</th>
                  <th className="pb-2 text-right font-medium">Delayed</th>
                  <th className="pb-2 text-right font-medium">Failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {Object.entries(health.queues).map(([name, c]) => (
                  <tr key={name}>
                    <td className="py-2 font-medium capitalize">{name}</td>
                    <td className="py-2 text-right">{formatCount(c.active)}</td>
                    <td className="py-2 text-right">{formatCount(c.waiting)}</td>
                    <td className="py-2 text-right">{formatCount(c.delayed)}</td>
                    <td className={clsx("py-2 text-right", c.failed > 0 && "text-danger")}>{formatCount(c.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-12">
        <h2 className="mb-4 text-xl font-bold">Members</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-faint">
              <tr>
                <th className="pb-2 font-medium">Member</th>
                <th className="pb-2 font-medium">YouTube</th>
                <th className="pb-2 text-right font-medium">Songs</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {members.map((m) => (
                <tr key={m.id} className={clsx(m.status === "disabled" && "text-faint")}>
                  <td className="py-3">
                    <p className="font-semibold">
                      {m.name} {m.role === "admin" && <span className="ml-1 text-xs font-medium text-mint">admin</span>}
                      {m.status === "disabled" && <span className="ml-1 text-xs font-medium text-danger">disabled</span>}
                    </p>
                    <p className="text-muted">{m.email}</p>
                  </td>
                  <td className="py-3 text-muted">{m.linked ? `Synced ${timeAgo(m.last_synced_at)}` : "Not linked"}</td>
                  <td className="py-3 text-right tabular">{formatCount(Number(m.tracks))}</td>
                  <td className="py-3">
                    {m.id !== admin.id && (
                      <div className="flex justify-end gap-2">
                        <ActionButton action={setMemberRole.bind(null, m.id, m.role === "admin" ? "user" : "admin")}>
                          {m.role === "admin" ? "Make member" : "Make admin"}
                        </ActionButton>
                        {m.status === "active" ? (
                          <ActionButton action={setMemberStatus.bind(null, m.id, "disabled")} tone="danger" confirm={`Disable ${m.name}? They'll be signed out everywhere.`}>
                            Disable
                          </ActionButton>
                        ) : (
                          <ActionButton action={setMemberStatus.bind(null, m.id, "active")}>Enable</ActionButton>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">Failed songs</h2>
            <p className="text-sm text-muted">Across every member. The reason sits under each status.</p>
          </div>
          {failed.length > 0 && <ActionButton action={retryAllFailed}>Retry all {formatCount(failed.length)}</ActionButton>}
        </div>
        <LiveTrackList initial={failed} mode="jobs" empty={<p className="text-muted">Nothing has failed.</p>} />
      </section>
    </>
  );
}
