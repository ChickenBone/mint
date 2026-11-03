import { Heart } from "lucide-react";
import type { Metadata } from "next";
import { LinkYoutubeCallout } from "@/components/app/link-youtube";
import { LiveTrackList } from "@/components/app/live-track-list";
import { CoverMosaic, firstCover, PageHeader } from "@/components/app/page-header";
import { requireUser } from "@/lib/auth";
import { getLikedTracks, getYoutubeAccount } from "@/lib/data";
import { formatCount, formatHours } from "@/lib/format";

export const metadata: Metadata = { title: "Liked songs" };

export default async function Liked() {
  const user = await requireUser();
  const [tracks, acct] = await Promise.all([getLikedTracks(user.id), getYoutubeAccount(user.id)]);
  const landed = tracks.filter((t) => t.stage === "ready" || t.stage === "analyzing");
  const secs = tracks.reduce((n, t) => n + (t.durationSec ?? 0), 0);
  return (
    <>
      <PageHeader
        title="Liked songs"
        backdrop={firstCover(landed)}
        art={
          <CoverMosaic
            tracks={landed}
            fallback={
              <div className="grid size-full place-items-center bg-mint text-mint-ink">
                <Heart className="size-16" fill="currentColor" aria-hidden />
              </div>
            }
          />
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
