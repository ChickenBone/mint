"use client";

import type { WorkerView } from "@mint/core/agent-protocol";
import clsx from "clsx";
import { KeyRound, Server } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { createWorker, revokeWorker, type CreateWorkerState } from "@/app/actions/workers";
import { Field, SubmitButton } from "@/components/form";
import { formatBytes, formatCount, timeAgo } from "@/lib/format";
import { useRealtime } from "../realtime";
import { ActionButton } from "./admin-controls";
import { CopyButton } from "./copy-button";

const ONLINE_MS = 90_000;
type Row = WorkerView & { tokenHint: string; createdAt: string };

/** Re-renders every `ms` so "online" decays without a server event. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function WorkerStatus({ w, now }: { w: Pick<WorkerView, "status" | "lastSeenAt">; now: number }) {
  const online = w.lastSeenAt != null && now - new Date(w.lastSeenAt).getTime() < ONLINE_MS;
  const [label, tone] =
    w.status === "disabled"
      ? ["Disabled", "text-danger"]
      : w.status === "pending"
        ? [online ? "Connected · awaiting approval" : "Awaiting approval", "text-warn"]
        : online
          ? ["Online", "text-mint"]
          : [w.lastSeenAt ? "Offline" : "Never connected", "text-faint"];
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-sm font-medium", tone)}>
      <span className={clsx("size-2 rounded-full bg-current", online && w.status === "active" && "animate-pulse")} aria-hidden />
      {label}
    </span>
  );
}

export function WorkersPanel({ initial, origin }: { initial: Row[]; origin: string }) {
  const [state, action] = useActionState<CreateWorkerState, FormData>(createWorker, undefined);
  const [workers, setWorkers] = useState(initial);
  const [source, setSource] = useState(initial);
  if (source !== initial) {
    setSource(initial);
    setWorkers(initial);
  }
  const now = useNow(15_000);
  useRealtime((e) => {
    if (e.type !== "worker") return;
    setWorkers((prev) => prev.map((w) => (w.id === e.data.id ? { ...w, ...e.data } : w)));
  });

  const setup = state?.token
    ? [
        "mkdir mint-worker && cd mint-worker",
        `curl -fsSL ${origin}/worker.yml -o compose.yml`,
        `echo "MINT_WORKER_TOKEN=${state.token}" > .env`,
        "docker compose up -d",
      ].join("\n")
    : "";

  return (
    <div className="grid gap-12">
      <section aria-labelledby="new-worker">
        <h2 id="new-worker" className="text-xl font-bold">Add a volunteer</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">Each machine gets its own token so you can revoke one without touching the others.</p>
        <form action={action} className="mt-5 flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Name" name="name" placeholder="living-room-nas" required maxLength={40} error={state?.error} className="flex-1" autoComplete="off" />
          <SubmitButton pendingLabel="Creating…" className="sm:mb-0">Create token</SubmitButton>
        </form>

        {state?.token && (
          <div className="mt-6 max-w-3xl rounded-xl bg-elevated p-5 ring-1 ring-mint/40" role="status">
            <p className="flex items-center gap-2 font-semibold">
              <KeyRound className="size-4 text-mint" aria-hidden /> Token for {state.name}
            </p>
            <p className="mt-1 text-sm text-muted">Copy it now. Mint only keeps a hash, so it can&apos;t show it again.</p>
            <div className="mt-4 flex items-center gap-3 rounded-lg bg-bg px-4 py-3">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">{state.token}</code>
              <CopyButton text={state.token} />
            </div>

            <p className="mt-6 text-sm font-semibold">Run it on any machine with Docker</p>
            <div className="mt-2 flex items-start gap-3 rounded-lg bg-bg px-4 py-3">
              <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-sm leading-relaxed text-muted scrollbar-thin">{setup}</pre>
              <CopyButton text={setup} />
            </div>
            {state.status === "pending" && (
              <p className="mt-4 text-sm text-warn">An admin needs to approve this worker before it receives jobs. It can connect in the meantime.</p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="your-workers">
        <h2 id="your-workers" className="text-xl font-bold">Your volunteer workers</h2>
        {workers.length === 0 ? (
          <div className="mt-4 flex max-w-xl items-center gap-4 rounded-xl bg-elevated p-5 text-muted">
            <Server className="size-8 shrink-0 text-faint" aria-hidden />
            <p>No volunteers registered. The built-in NAS worker needs no registration. Add a token only for an optional extra machine.</p>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-xl bg-elevated">
            {workers.map((w) => (
              <li key={w.id} className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="truncate font-semibold">{w.name}</span>
                    <WorkerStatus w={w} now={now} />
                  </p>
                  <p className="mt-1 text-xs text-faint">
                    <code className="font-mono">{w.tokenHint}…</code>
                    {w.version && <> · v{w.version}</>} · seen {w.lastSeenAt ? timeAgo(w.lastSeenAt) : "never"}
                    {w.activeJobs > 0 && <> · <span className="text-mint">{w.activeJobs} working</span></>}
                  </p>
                </div>
                <dl className="flex gap-6 text-sm tabular">
                  <div>
                    <dt className="text-faint">Delivered</dt>
                    <dd className="font-semibold">{formatCount(w.completed)}</dd>
                  </div>
                  <div>
                    <dt className="text-faint">Failed</dt>
                    <dd className={clsx("font-semibold", w.failed > 0 && "text-danger")}>{formatCount(w.failed)}</dd>
                  </div>
                  <div>
                    <dt className="text-faint">Uploaded</dt>
                    <dd className="font-semibold">{formatBytes(w.bytes)}</dd>
                  </div>
                </dl>
                <ActionButton action={revokeWorker.bind(null, w.id)} tone="danger" confirm={`Revoke ${w.name}? The container stops getting jobs immediately.`}>
                  Revoke
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type AdminRow = WorkerView & { owner: string; lastIp: string | null; createdAt: string };

export function AdminWorkers({ initial, actions }: { initial: AdminRow[]; actions: { setStatus: (id: string, s: "active" | "disabled") => Promise<unknown>; revoke: (id: string) => Promise<unknown> } }) {
  const [workers, setWorkers] = useState(initial);
  const [source, setSource] = useState(initial);
  if (source !== initial) {
    setSource(initial);
    setWorkers(initial);
  }
  const now = useNow(15_000);
  useRealtime((e) => {
    if (e.type !== "worker") return;
    setWorkers((prev) => prev.map((w) => (w.id === e.data.id ? { ...w, ...e.data } : w)));
  });

  if (workers.length === 0) return <p className="text-muted">No one has registered a worker yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead className="text-left text-faint">
          <tr>
            <th className="pb-2 font-medium">Worker</th>
            <th className="pb-2 font-medium">Status</th>
            <th className="pb-2 text-right font-medium">Delivered</th>
            <th className="pb-2 text-right font-medium">Failed</th>
            <th className="pb-2 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {workers.map((w) => (
            <tr key={w.id}>
              <td className="py-3">
                <p className="font-semibold">{w.name}</p>
                <p className="text-muted">
                  {w.owner}
                  {w.lastIp && <> · <span className="font-mono text-xs">{w.lastIp}</span></>}
                  {w.version && <> · v{w.version}</>}
                </p>
              </td>
              <td className="py-3">
                <WorkerStatus w={w} now={now} />
                <p className="text-xs text-faint">seen {w.lastSeenAt ? timeAgo(w.lastSeenAt) : "never"}</p>
              </td>
              <td className="py-3 text-right tabular">{formatCount(w.completed)}</td>
              <td className={clsx("py-3 text-right tabular", w.failed > 0 && "text-danger")}>{formatCount(w.failed)}</td>
              <td className="py-3">
                <div className="flex justify-end gap-2">
                  {w.status !== "active" ? (
                    <ActionButton action={() => actions.setStatus(w.id, "active")} tone="primary">
                      {w.status === "pending" ? "Approve" : "Enable"}
                    </ActionButton>
                  ) : (
                    <ActionButton action={() => actions.setStatus(w.id, "disabled")} confirm={`Disable ${w.name}? Its current jobs go back to the pool.`}>
                      Disable
                    </ActionButton>
                  )}
                  <ActionButton action={() => actions.revoke(w.id)} tone="danger" confirm={`Revoke ${w.name} for good? ${w.owner} will need a new token.`}>
                    Revoke
                  </ActionButton>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
