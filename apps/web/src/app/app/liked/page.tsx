import { Heart } from "lucide-react";
import type { Metadata } from "next";
import { LinkYoutubeCallout } from "@/components/app/link-youtube";
import { LiveTrackList } from "@/components/app/live-track-list";
import { PageHeader } from "@/components/app/page-header";
import { requireUser } from "@/lib/auth";
import { getLikedTracks, getYoutubeAccount } from "@/lib/data";
import { formatCount, formatHours } from "@/lib/format";

export const metadata: Metadata = { title: "Liked songs" };

export default async function Liked() {
  const user = await requireUser();
  const [tracks, acct] = await Promise.all([getLikedTracks(user.id), getYoutubeAccount(user.id)]);
  const secs = tracks.reduce((n, t) => n + (t.durationSec ?? 0), 0);
  return (
    <>
      <PageHeader
        title="Liked songs"
        className="bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-mint)_30%,transparent),transparent)]"
        art={
          <div className="grid size-40 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-mint to-[#1d6b4e] text-mint-ink shadow-[0_20px_50px_-15px_rgb(0_0_0/0.8)] sm:size-52">
            <Heart className="size-16" fill="currentColor" aria-hidden />
          </div>
        }
        sub={
          <p className="tabular">
            {user.name} · {formatCount(tracks.length)} songs · {formatHours(secs)}. In Plexamp as <span className="text-fg">Mint · {user.name} · Liked</span>.
          </p>
        }
      />
      {!acct ? (
        <LinkYoutubeCallout />
      ) : (
        <LiveTrackList
          initial={tracks}
          empty={<p className="py-12 text-muted">No likes yet. Like a song in YouTube Music, then press Sync now on Home.</p>}
        />
      )}
    </>
  );
}
