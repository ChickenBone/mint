import type { Metadata } from "next";
import { LiveTrackList } from "@/components/app/live-track-list";
import { PageHeader } from "@/components/app/page-header";
import { requireUser } from "@/lib/auth";
import { getUserJobs } from "@/lib/data";

export const metadata: Metadata = { title: "Jobs" };

export default async function Jobs() {
  const user = await requireUser();
  const jobs = await getUserJobs(user.id);
  const failed = jobs.filter((j) => j.stage === "failed");
  const active = jobs.filter((j) => j.stage !== "failed");
  return (
    <>
      <PageHeader
        title="Jobs"
        sub={
          <p className="max-w-2xl">
            Your songs that are still on their way. Each one is matched, searched for as a full release, downloaded, tagged, scanned by Plex and
            sonically analysed. Songs stuck searching can skip straight to a YouTube rip with the fast-forward button.
          </p>
        }
      />
      <section>
        <h2 className="mb-3 text-xl font-bold">In progress</h2>
        <LiveTrackList initial={active} mode="jobs" empty={<p className="py-6 text-muted">Nothing in flight. Everything you&rsquo;ve liked is already on the server.</p>} />
      </section>
      <section className="mt-12">
        <h2 className="mb-1 text-xl font-bold">Needs attention</h2>
        <p className="mb-3 text-sm text-muted">Songs that couldn&rsquo;t be found or downloaded. Retry to run them through the pipeline again.</p>
        <LiveTrackList initial={failed} mode="jobs" empty={<p className="py-6 text-muted">No failures.</p>} />
      </section>
    </>
  );
}
