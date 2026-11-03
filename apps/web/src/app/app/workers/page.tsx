import type { Metadata } from "next";
import { PageHeader } from "@/components/app/page-header";
import { WorkersPanel } from "@/components/app/workers-panel";
import { requireUser } from "@/lib/auth";
import { getHealth, getMyWorkers, getRemotePoolSize, getStats } from "@/lib/data";
import { formatCount } from "@/lib/format";
import { publicUrl } from "@/lib/request";

export const metadata: Metadata = { title: "Workers" };

const FACTS: Array<[string, string]> = [
  ["What it does", "Asks Mint for a song, rips the audio with its own Cobalt, and uploads it. The home server tags it and hands it to Plex."],
  ["What it needs", "Docker, a few hundred MB of disk, and outbound HTTPS. No open ports, no port forwarding."],
  ["What it never sees", "Plex, Lidarr, TorBox, the database, or anyone's account. Its token can only claim jobs and upload audio."],
];

export default async function Workers() {
  const user = await requireUser();
  const [workers, pool, stats, health] = await Promise.all([getMyWorkers(user.id), getRemotePoolSize(), getStats(), getHealth()]);
  const localOnline = Boolean(health?.localWorker?.online);

  return (
    <>
      <PageHeader
        title="Workers"
        sub={
          <p className="max-w-2xl">
            Optional volunteer machines. <span className="text-fg tabular">{formatCount(stats.workersOnline ?? 0)}</span> volunteers online,{" "}
            <span className="text-fg tabular">{formatCount(pool)}</span> {pool === 1 ? "song" : "songs"} waiting for one.
          </p>
        }
      />
      <section className="mb-8 border-b border-line pb-6">
        <h2 className="text-xl font-bold">Built-in NAS worker</h2>
        <p className="mt-2 text-muted">
          {localOnline
            ? `Online. Handles ${health!.localWorker!.acquisition} acquisition jobs concurrently, then tags and files downloads. No worker token or volunteer registration needed.`
            : "No recent heartbeat. Check the worker container logs in your NAS Docker project."}
        </p>
      </section>
      <WorkersPanel initial={workers} origin={publicUrl()} />
      <dl className="mt-14 grid max-w-5xl gap-8 border-t border-line pt-8 md:grid-cols-3">
        {FACTS.map(([k, v]) => (
          <div key={k}>
            <dt className="font-semibold">{k}</dt>
            <dd className="mt-1 text-sm text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
