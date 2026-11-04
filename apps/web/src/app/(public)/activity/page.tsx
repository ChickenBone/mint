import { PipelineBoard } from "@/components/pipeline-board";
import { LiveStats } from "@/components/live-stats";
import { getActiveTracks, getStats } from "@/lib/data";

export const dynamic = "force-dynamic";
export default async function Activity() {
  const [tracks, stats] = await Promise.all([getActiveTracks(120), getStats()]);
  return <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8">
    <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Making room for more music.</h1>
    <p className="mt-4 mb-10 max-w-2xl text-muted">The shared library’s live activity. Member identities remain private; audio and acquisition requests require an approved account.</p>
    <LiveStats initial={stats} /><div className="mt-12"><PipelineBoard initialTracks={tracks} initialStats={stats} /></div>
  </div>;
}
