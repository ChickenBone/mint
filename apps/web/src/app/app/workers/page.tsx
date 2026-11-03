import type { Metadata } from "next";
import { PageHeader } from "@/components/app/page-header";
import { WorkersPanel } from "@/components/app/workers-panel";
import { requireUser } from "@/lib/auth";
import { getMyWorkers, getRemotePoolSize, getStats } from "@/lib/data";
import { formatCount } from "@/lib/format";
import { publicUrl } from "@/lib/request";

export const metadata: Metadata = { title: "Workers" };

const FACTS: Array<[string, string]> = [
  ["What it does", "Asks Mint for a song, rips the audio with its own Cobalt, and uploads it. The home server tags it, cuts the preview and hands it to Plex."],
  ["What it needs", "Docker, a few hundred MB of disk, and outbound HTTPS. No open ports, no port forwarding."],
  ["What it never sees", "Plex, Lidarr, TorBox, the database, or anyone's account. Its token can only claim jobs and upload audio."],
];

export default async function Workers() {
  const user = await requireUser();
  const [workers, pool, stats] = await Promise.all([getMyWorkers(user.id), getRemotePoolSize(), getStats()]);

  return (
    <>
      <PageHeader
        title="Workers"
        sub={
          <p className="max-w-2xl">
            Lend a machine to the pipeline. <span className="text-fg tabular">{formatCount(stats.workersOnline ?? 0)}</span> online right now,{" "}
            <span className="text-fg tabular">{formatCount(pool)}</span> {pool === 1 ? "song" : "songs"} waiting for one.
          </p>
        }
      />
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
