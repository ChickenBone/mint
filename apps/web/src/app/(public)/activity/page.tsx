import type { Metadata } from "next";
import Link from "next/link";
import { LiveStats } from "@/components/live-stats";
import { PipelineBoard } from "@/components/pipeline-board";
import { getUser } from "@/lib/auth";
import { getActiveTracks, getStats } from "@/lib/data";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

export default async function Activity() {
  const [tracks, stats, user] = await Promise.all([getActiveTracks(120), getStats(), getUser()]);
  return (
    <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8">
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Making room for more music.</h1>
          <p className="mt-4 max-w-prose text-muted">
            The shared library&rsquo;s live activity. Member identities remain private; audio and acquisition requests require an approved account.
          </p>
        </div>
        <Link
          href={user ? "/app" : "/request-access"}
          className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong"
        >
          {user ? "Open Mint" : "Request access"}
        </Link>
      </div>
      <LiveStats initial={stats} />
      <div className="mt-12">
        <PipelineBoard initialTracks={tracks} initialStats={stats} />
      </div>
    </div>
  );
}
