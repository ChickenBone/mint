"use client";

import clsx from "clsx";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import type { TrackView } from "@mint/core/events";
import type { WorkerView } from "@mint/core";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  MinusCircle,
  ShieldCheck,
  UserCheck,
  XCircle,
} from "lucide-react";
import {
  decideRequest,
  retryAllFailed,
  setIssueReportResolved,
  setMemberRole,
  setMemberStatus,
} from "@/app/actions/admin";
import { revokeWorker, setWorkerStatus } from "@/app/actions/workers";
import { Badge } from "@/components/ui/primitives";
import { resolveManageTab, type ManageTab } from "@/lib/app-routes";
import type { Health } from "@/lib/data";
import { issueCategoryLabel, type IssueReportView } from "@/lib/issue-report-model";
import { formatCount, timeAgo } from "@/lib/format";
import { ActionButton } from "./admin-controls";
import { AnalysisPanel } from "./analysis-panel";
import { MatchingPanel } from "./matching-panel";
import { LiveTrackList } from "./live-track-list";
import { AdminWorkers, WorkersPanel } from "./workers-panel";

type AdminWorkerRow = WorkerView & {
  owner: string;
  lastIp: string | null;
  createdAt: string;
};

type MyWorkerRow = WorkerView & {
  tokenHint: string;
  createdAt: string;
};

export interface ManageViewProps {
  adminId: string;
  origin: string;
  requests: Array<{
    id: string;
    name: string;
    email: string;
    requestNote: string | null;
    createdAt: string;
  }>;
  members: Array<{
    id: string;
    email: string;
    name: string;
    role: "user" | "admin";
    status: string;
    created_at: string;
    tracks: string;
    linked: boolean;
    last_synced_at: string | null;
  }>;
  failedTracks: TrackView[];
  activeTracks: TrackView[];
  health: Health | null;
  allWorkers: AdminWorkerRow[];
  myWorkers: MyWorkerRow[];
  remotePoolSize: number;
  issueReports: { open: IssueReportView[]; resolved: IssueReportView[]; openCount: number };
}

const SERVICE_LABEL = {
  lidarr: "Lidarr",
  torbox: "TorBox",
  cobalt: "Cobalt",
  plex: "Plex",
} as const;

const WORKER_FACTS: Array<[string, string]> = [
  [
    "What it does",
    "Asks Mint for a song, rips the audio with its own Cobalt, and uploads it. The home server tags it and hands it to Plex.",
  ],
  [
    "What it needs",
    "Docker, a few hundred MB of disk, and outbound HTTPS. No open ports, no port forwarding.",
  ],
  [
    "What it never sees",
    "Plex, Lidarr, TorBox, the database, or anyone's account. Its token can only claim jobs and upload audio.",
  ],
];

function formatRelative(iso: string | null | undefined, now: number | null) {
  if (!iso) return "never";
  if (now === null) return iso.slice(0, 10);
  return timeAgo(iso, now);
}

export function ManageView({
  adminId,
  origin,
  requests,
  members,
  failedTracks,
  activeTracks,
  health,
  allWorkers,
  myWorkers,
  remotePoolSize,
  issueReports,
}: ManageViewProps) {
  const searchParams = useSearchParams();
  const tab = resolveManageTab(searchParams.get("tab"));
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const initial = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);

  const pendingWorkers = allWorkers.filter((w) => w.status === "pending").length;
  const localOnline = Boolean(health?.localWorker?.online);
  const serviceKeys = Object.keys(SERVICE_LABEL) as Array<keyof typeof SERVICE_LABEL>;
  const page = {
    requests: {
      title: "Members",
      description: "Review access requests and manage the people who can listen to Mint.",
    },
    reports: {
      title: "Reports",
      description: "Triage issues sent by members and revisit recently resolved reports.",
    },
    jobs: {
      title: "Activity",
      description: "Monitor service reachability, processing queues and failed jobs.",
    },
    workers: {
      title: "Workers",
      description: "Manage the built-in server worker and optional volunteer machines.",
    },
    analysis: {
      title: "Audio analysis",
      description: "Configure analysis and inspect processing coverage and results.",
    },
    matching: {
      title: "Matching",
      description: "Choose when OpenAI may pick a recording. Deterministic matching remains the fallback.",
    },
  }[tab];

  return (
    <div className="admin-frame mx-auto max-w-7xl space-y-8">
      <header className="mb-9 border-b border-line/70 pb-6">
        <h1 className="text-3xl leading-tight font-bold tracking-[-0.03em] text-fg">{page.title}</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">{page.description}</p>
        {tab === "requests" && requests.length > 0 && (
          <p className="mt-4 inline-flex min-h-8 items-center rounded-full bg-warn/10 px-3 text-sm font-semibold text-warn">
            {formatCount(requests.length)} waiting for review
          </p>
        )}
      </header>

      <AdminSectionContent
        value={tab}
        sections={[
          {
            value: "requests",
            content: (
              <div className="space-y-10">
                <section aria-labelledby="manage-access-requests">
                  <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h2 id="manage-access-requests" className="text-xl font-bold">
                        Access requests{" "}
                        {requests.length > 0 && (
                          <span className="text-mint tabular">({formatCount(requests.length)})</span>
                        )}
                      </h2>
                      <p className="mt-1 max-w-prose text-sm text-muted">
                        Approve people you know to activate their Mint login, or deny requests to discard them.
                      </p>
                    </div>
                  </div>

                  {requests.length === 0 ? (
                    <p className="rounded-xl border border-line/60 bg-elevated/50 p-5 text-sm text-muted">
                      No one is waiting right now. New access requests appear here automatically.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line rounded-xl border border-line/70 bg-elevated">
                      {requests.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-fg">
                              {r.name} <span className="font-normal text-muted">{r.email}</span>
                            </p>
                            {r.requestNote && (
                              <p className="mt-1 max-w-prose text-sm text-muted">&ldquo;{r.requestNote}&rdquo;</p>
                            )}
                            <p className="mt-1 text-xs text-faint">Asked {formatRelative(r.createdAt, now)}</p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <ActionButton
                              action={decideRequest.bind(null, r.id, false)}
                              tone="danger"
                              confirm={`Deny access request from ${r.name} (${r.email})? Their pending request will be removed.`}
                            >
                              Deny
                            </ActionButton>
                            <ActionButton action={decideRequest.bind(null, r.id, true)} tone="primary">
                              Approve
                            </ActionButton>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section aria-labelledby="manage-members">
                  <div className="mb-4">
                    <h2 id="manage-members" className="text-xl font-bold">
                      Members <span className="text-sm font-normal text-muted tabular">({formatCount(members.length)})</span>
                    </h2>
                    <p className="mt-1 max-w-prose text-sm text-muted">
                      Manage member roles, connected YouTube sync status and account access.
                    </p>
                  </div>

                  {/* Mobile stacked cards */}
                  <ul className="space-y-3 md:hidden" aria-label="Members list">
                    {members.map((m) => (
                      <li
                        key={m.id}
                        className={clsx(
                          "rounded-xl border border-line/70 bg-elevated p-4",
                          m.status === "disabled" && "opacity-75",
                        )}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold text-fg">{m.name}</p>
                            <p className="truncate text-sm text-muted">{m.email}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {m.role === "admin" ? (
                              <Badge tone="positive">
                                <ShieldCheck className="size-3.5" aria-hidden />
                                Admin
                              </Badge>
                            ) : (
                              <Badge tone="neutral">
                                <UserCheck className="size-3.5" aria-hidden />
                                Member
                              </Badge>
                            )}
                            {m.status === "disabled" && (
                              <Badge tone="danger">
                                <XCircle className="size-3.5" aria-hidden />
                                Disabled
                              </Badge>
                            )}
                          </div>
                        </div>

                        <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-line/60 pt-3 text-xs">
                          <div>
                            <dt className="text-faint">YouTube Music</dt>
                            <dd className="mt-0.5 text-muted">
                              {m.linked ? `Synced ${formatRelative(m.last_synced_at, now)}` : "Not linked"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-faint">Songs in library</dt>
                            <dd className="mt-0.5 font-medium tabular text-fg">
                              {formatCount(Number(m.tracks))}
                            </dd>
                          </div>
                        </dl>

                        {m.id !== adminId && (
                          <div className="mt-3 flex flex-wrap gap-2 border-t border-line/60 pt-3">
                            <ActionButton
                              action={setMemberRole.bind(null, m.id, m.role === "admin" ? "user" : "admin")}
                              confirm={
                                m.role === "admin"
                                  ? `Change ${m.name} from admin to member?`
                                  : `Grant ${m.name} full admin access to Management?`
                              }
                            >
                              {m.role === "admin" ? "Make member" : "Make admin"}
                            </ActionButton>
                            {m.status === "active" ? (
                              <ActionButton
                                action={setMemberStatus.bind(null, m.id, "disabled")}
                                tone="danger"
                                confirm={`Disable ${m.name}? They'll be signed out everywhere.`}
                              >
                                Disable
                              </ActionButton>
                            ) : (
                              <ActionButton action={setMemberStatus.bind(null, m.id, "active")}>
                                Enable
                              </ActionButton>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>

                  {/* Desktop table */}
                  <div className="hidden overflow-x-auto rounded-xl border border-line/70 bg-elevated md:block">
                    <table className="w-full text-sm">
                      <thead className="border-b border-line/70 text-left text-xs font-semibold tracking-wider text-faint uppercase">
                        <tr>
                          <th className="px-4 py-3">Member</th>
                          <th className="px-4 py-3">Role & status</th>
                          <th className="px-4 py-3">YouTube</th>
                          <th className="px-4 py-3 text-right">Songs</th>
                          <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line/60">
                        {members.map((m) => (
                          <tr key={m.id} className={clsx(m.status === "disabled" && "text-faint")}>
                            <td className="px-4 py-3">
                              <p className="font-semibold text-fg">{m.name}</p>
                              <p className="text-muted">{m.email}</p>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap items-center gap-1.5">
                                {m.role === "admin" ? (
                                  <Badge tone="positive">
                                    <ShieldCheck className="size-3.5" aria-hidden />
                                    Admin
                                  </Badge>
                                ) : (
                                  <Badge tone="neutral">Member</Badge>
                                )}
                                {m.status === "disabled" && (
                                  <Badge tone="danger">
                                    <XCircle className="size-3.5" aria-hidden />
                                    Disabled
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-muted">
                              {m.linked ? `Synced ${formatRelative(m.last_synced_at, now)}` : "Not linked"}
                            </td>
                            <td className="px-4 py-3 text-right tabular">{formatCount(Number(m.tracks))}</td>
                            <td className="px-4 py-3">
                              {m.id !== adminId && (
                                <div className="flex justify-end gap-2">
                                  <ActionButton
                                    action={setMemberRole.bind(null, m.id, m.role === "admin" ? "user" : "admin")}
                                    confirm={
                                      m.role === "admin"
                                        ? `Change ${m.name} from admin to member?`
                                        : `Grant ${m.name} full admin access to Management?`
                                    }
                                  >
                                    {m.role === "admin" ? "Make member" : "Make admin"}
                                  </ActionButton>
                                  {m.status === "active" ? (
                                    <ActionButton
                                      action={setMemberStatus.bind(null, m.id, "disabled")}
                                      tone="danger"
                                      confirm={`Disable ${m.name}? They'll be signed out everywhere.`}
                                    >
                                      Disable
                                    </ActionButton>
                                  ) : (
                                    <ActionButton action={setMemberStatus.bind(null, m.id, "active")}>
                                      Enable
                                    </ActionButton>
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
              </div>
            ),
          },
          {
            value: "reports",
            content: (
              <div className="space-y-10">
                <section aria-labelledby="manage-open-reports">
                  <div className="mb-4">
                    <h2 id="manage-open-reports" className="text-xl font-bold">
                      Open reports{" "}
                      {issueReports.openCount > 0 && (
                        <span className="text-mint tabular">({formatCount(issueReports.openCount)})</span>
                      )}
                    </h2>
                    <p className="mt-1 max-w-prose text-sm text-muted">
                      Problems members sent with Report an issue. Mark each one resolved once it&apos;s handled.
                    </p>
                  </div>
                  {issueReports.open.length === 0 ? (
                    <p className="rounded-xl border border-line/60 bg-elevated/50 p-5 text-sm text-muted">
                      No open reports. New ones appear here when a member sends one.
                    </p>
                  ) : (
                    <IssueReportList reports={issueReports.open} now={now} />
                  )}
                  {issueReports.open.length < issueReports.openCount && (
                    <p className="mt-3 text-xs text-muted">
                      Showing the newest {formatCount(issueReports.open.length)}. Resolve some to see older reports.
                    </p>
                  )}
                </section>

                {issueReports.resolved.length > 0 && (
                  <section aria-labelledby="manage-resolved-reports">
                    <h2 id="manage-resolved-reports" className="mb-4 text-xl font-bold">Recently resolved</h2>
                    <IssueReportList reports={issueReports.resolved} now={now} />
                  </section>
                )}
              </div>
            ),
          },
          {
            value: "jobs",
            content: (
              <div className="space-y-10">
                <section aria-labelledby="manage-services">
                  <h2 id="manage-services" className="text-xl font-bold">
                    Services and pipeline queues
                  </h2>
                  <p className="mt-1 max-w-prose text-sm text-muted">
                    {health
                      ? `Last checked ${formatRelative(health.checkedAt, now)} by the pipeline worker.`
                      : "The pipeline worker has not reported yet. Check that the worker container is running."}
                  </p>

                  {health?.notes && health.notes.length > 0 && (
                    <ul className="mt-4 flex max-w-prose flex-col gap-2">
                      {health.notes.map((n) => (
                        <li key={n} className="rounded-xl border border-warn/40 bg-elevated px-4 py-3 text-sm">
                          <span className="font-semibold text-warn">To finish setup: </span>
                          {n}
                        </li>
                      ))}
                    </ul>
                  )}

                  {health?.libraryIndex && (
                    <p className="mt-4 max-w-prose text-sm text-muted" role="status">
                      Existing library: {health.libraryIndex.state}. {formatCount(health.libraryIndex.indexed)} indexed
                      {health.libraryIndex.total !== undefined ? ` of ${formatCount(health.libraryIndex.total)}` : ""}
                      {health.libraryIndex.skipped > 0
                        ? `; ${formatCount(health.libraryIndex.skipped)} skipped (check worker logs and folder mappings)`
                        : ""}
                      .{health.libraryIndex.message ? ` ${health.libraryIndex.message}` : ""}
                    </p>
                  )}

                  {health && (
                    <div className="mt-6 grid gap-6 lg:grid-cols-[18rem_1fr]">
                      <ul className="space-y-2 rounded-xl border border-line/70 bg-elevated p-4">
                        {serviceKeys.map((k) => {
                          const ok = health.services[k];
                          return (
                            <li key={k} className="flex items-center justify-between py-1">
                              <span className="font-medium text-fg">{SERVICE_LABEL[k]}</span>
                              {ok === null ? (
                                <Badge tone="neutral">
                                  <MinusCircle className="size-3.5" aria-hidden />
                                  Not configured
                                </Badge>
                              ) : ok ? (
                                <Badge tone="positive">
                                  <CheckCircle2 className="size-3.5" aria-hidden />
                                  Reachable
                                </Badge>
                              ) : (
                                <Badge tone="danger">
                                  <AlertTriangle className="size-3.5" aria-hidden />
                                  Down
                                </Badge>
                              )}
                            </li>
                          );
                        })}
                      </ul>

                      {/* Mobile stacked cards for queues */}
                      <ul className="grid gap-3 sm:grid-cols-2 md:hidden" aria-label="Pipeline queues">
                        {Object.entries(health.queues).map(([name, c]) => (
                          <li key={name} className="rounded-xl border border-line/70 bg-elevated p-4 text-sm">
                            <p className="font-semibold text-fg capitalize">{name}</p>
                            <dl className="mt-2 grid grid-cols-2 gap-2 text-xs tabular">
                              <div>
                                <dt className="text-faint">Active</dt>
                                <dd className="font-medium text-fg">{formatCount(c.active)}</dd>
                              </div>
                              <div>
                                <dt className="text-faint">Waiting</dt>
                                <dd className="font-medium text-fg">{formatCount(c.waiting)}</dd>
                              </div>
                              <div>
                                <dt className="text-faint">Delayed</dt>
                                <dd className="font-medium text-fg">{formatCount(c.delayed)}</dd>
                              </div>
                              <div>
                                <dt className="text-faint">Failed</dt>
                                <dd className={clsx("font-medium", c.failed > 0 ? "text-danger" : "text-fg")}>
                                  {formatCount(c.failed)}
                                </dd>
                              </div>
                            </dl>
                          </li>
                        ))}
                      </ul>

                      {/* Desktop table for queues */}
                      <div className="hidden overflow-x-auto rounded-xl border border-line/70 bg-elevated p-4 md:block">
                        <table className="w-full text-sm tabular">
                          <thead className="text-left text-xs font-semibold tracking-wider text-faint uppercase">
                            <tr>
                              <th className="pb-2">Queue</th>
                              <th className="pb-2 text-right">Active</th>
                              <th className="pb-2 text-right">Waiting</th>
                              <th className="pb-2 text-right">Delayed</th>
                              <th className="pb-2 text-right">Failed</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line/60">
                            {Object.entries(health.queues).map(([name, c]) => (
                              <tr key={name}>
                                <td className="py-2.5 font-medium capitalize">{name}</td>
                                <td className="py-2.5 text-right">{formatCount(c.active)}</td>
                                <td className="py-2.5 text-right">{formatCount(c.waiting)}</td>
                                <td className="py-2.5 text-right">{formatCount(c.delayed)}</td>
                                <td className={clsx("py-2.5 text-right font-semibold", c.failed > 0 && "text-danger")}>
                                  {formatCount(c.failed)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </section>

                <section aria-labelledby="manage-failed-jobs">
                  <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
                    <div>
                      <h2 id="manage-failed-jobs" className="text-xl font-bold">
                        Failed jobs{" "}
                        {failedTracks.length > 0 && (
                          <span className="text-danger tabular">({formatCount(failedTracks.length)})</span>
                        )}
                      </h2>
                      <p className="mt-1 max-w-prose text-sm text-muted">
                        Songs across every member that could not be matched, downloaded or finalized. Review the failure reason under each track and retry once resolved.
                      </p>
                    </div>
                    {failedTracks.length > 0 && (
                      <ActionButton action={retryAllFailed}>
                        Retry all {formatCount(failedTracks.length)}
                      </ActionButton>
                    )}
                  </div>
                  <LiveTrackList
                    initial={failedTracks}
                    mode="jobs"
                    empty={
                      <p className="rounded-xl border border-line/60 bg-elevated/50 p-5 text-sm text-muted">
                        Nothing has failed.
                      </p>
                    }
                  />
                </section>

                <section aria-labelledby="manage-active-jobs">
                  <div className="mb-4">
                    <h2 id="manage-active-jobs" className="text-xl font-bold">
                      In progress{" "}
                      {activeTracks.length > 0 && (
                        <span className="text-mint tabular">({formatCount(activeTracks.length)})</span>
                      )}
                    </h2>
                    <p className="mt-1 max-w-prose text-sm text-muted">
                      Songs currently moving through matching, release search, download, tagging and Plex scan. Tracks stuck searching can skip straight to a YouTube rip with the fast-forward button.
                    </p>
                  </div>
                  <LiveTrackList
                    initial={activeTracks}
                    mode="jobs"
                    empty={
                      <p className="rounded-xl border border-line/60 bg-elevated/50 p-5 text-sm text-muted">
                        Nothing in flight right now.
                      </p>
                    }
                  />
                </section>
              </div>
            ),
          },
          {
            value: "workers",
            content: (
              <div className="space-y-10">
                <section aria-labelledby="manage-nas-worker" className="rounded-xl border border-line/70 bg-elevated p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 id="manage-nas-worker" className="text-xl font-bold">
                      Built-in NAS worker
                    </h2>
                    {localOnline ? (
                      <Badge tone="positive">
                        <CheckCircle2 className="size-3.5" aria-hidden />
                        Online
                      </Badge>
                    ) : (
                      <Badge tone="warning">
                        <Clock3 className="size-3.5" aria-hidden />
                        No recent heartbeat
                      </Badge>
                    )}
                  </div>
                  <p className="mt-2 max-w-prose text-sm text-muted">
                    {localOnline
                      ? `Online. Handles ${health!.localWorker!.acquisition} acquisition jobs concurrently, then tags and files downloads. ${formatCount(remotePoolSize)} ${remotePoolSize === 1 ? "song" : "songs"} currently waiting in the volunteer pool.`
                      : "No recent heartbeat. Check the worker container logs in your NAS Docker project."}
                  </p>
                </section>

                <section aria-labelledby="manage-all-workers">
                  <h2 id="manage-all-workers" className="mb-1 text-xl font-bold">
                    Volunteer workers{" "}
                    {pendingWorkers > 0 && (
                      <span className="text-warn tabular">({formatCount(pendingWorkers)} to approve)</span>
                    )}
                  </h2>
                  <p className="mb-4 max-w-prose text-sm text-muted">
                    The built-in NAS pipeline runs independently of these optional volunteer machines. Disabling a volunteer returns its leased jobs to the pool.
                  </p>
                  <AdminWorkers
                    initial={allWorkers}
                    actions={{ setStatus: setWorkerStatus, revoke: revokeWorker }}
                  />
                </section>

                <section aria-labelledby="manage-my-workers" className="border-t border-line/60 pt-8">
                  <h2 id="manage-my-workers" className="mb-1 text-xl font-bold">
                    Register a volunteer worker
                  </h2>
                  <p className="mb-4 max-w-prose text-sm text-muted">
                    Create a scoped worker token for another machine to help rip audio from YouTube and upload it to the home server.
                  </p>
                  <WorkersPanel initial={myWorkers} origin={origin} />
                  <dl className="mt-10 grid max-w-5xl gap-6 border-t border-line/60 pt-6 md:grid-cols-3">
                    {WORKER_FACTS.map(([k, v]) => (
                      <div key={k}>
                        <dt className="font-semibold text-fg">{k}</dt>
                        <dd className="mt-1 max-w-prose text-sm text-muted">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </div>
            ),
          },
          {
            value: "analysis",
            content: <AnalysisPanel />,
          },
          {
            value: "matching",
            content: <MatchingPanel />,
          },
        ]}
      />
    </div>
  );
}

function AdminSectionContent({
  value,
  sections,
}: {
  value: ManageTab;
  sections: Array<{ value: ManageTab; content: ReactNode }>;
}) {
  return <>{sections.find((section) => section.value === value)?.content}</>;
}

function IssueReportList({ reports, now }: { reports: IssueReportView[]; now: number | null }) {
  return (
    <ul className="divide-y divide-line rounded-xl border border-line/70 bg-elevated">
      {reports.map((report) => (
        <li key={report.id} className="flex flex-wrap items-start justify-between gap-4 p-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
              {issueCategoryLabel(report.category)}
              {report.status === "resolved" && (
                <Badge tone="positive">
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  Resolved
                </Badge>
              )}
            </p>
            {report.context && (
              <p className="text-sm break-words text-muted">
                About <span className="text-fg">{report.context}</span>
              </p>
            )}
            <p className="max-w-prose text-sm whitespace-pre-wrap break-words text-fg">{report.message}</p>
            <p className="text-xs break-words text-faint">
              {report.reporter ? `${report.reporter.name} · ${report.reporter.email}` : "Former member"} · Sent{" "}
              {formatRelative(report.createdAt, now)}
              {report.status === "resolved" &&
                ` · Resolved ${formatRelative(report.resolvedAt, now)}${report.resolvedBy ? ` by ${report.resolvedBy}` : ""}`}
            </p>
          </div>
          {report.status === "open" ? (
            <ActionButton action={setIssueReportResolved.bind(null, report.id, true)} tone="primary">
              Mark resolved
            </ActionButton>
          ) : (
            <ActionButton action={setIssueReportResolved.bind(null, report.id, false)}>Reopen</ActionButton>
          )}
        </li>
      ))}
    </ul>
  );
}
