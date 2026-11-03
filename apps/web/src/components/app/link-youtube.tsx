import { ArrowRight } from "lucide-react";

export function LinkYoutubeCallout() {
  return (
    <div className="flex flex-col items-start gap-5 rounded-xl bg-elevated p-8 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl">
        <h2 className="text-2xl font-bold tracking-tight">Link YouTube Music to start</h2>
        <p className="mt-2 text-muted">
          Mint signs in with Google read-only, picks up your liked songs and playlists, and starts downloading. You can unlink any time.
        </p>
      </div>
      {/* A plain link: the OAuth flow is a full-page redirect. */}
      <a
        href="/api/oauth/google/start"
        className="inline-flex shrink-0 items-center gap-2 rounded-full bg-mint px-6 py-3 font-bold text-mint-ink transition hover:scale-[1.03] hover:bg-mint-strong"
      >
        Link with Google <ArrowRight className="size-4" aria-hidden />
      </a>
    </div>
  );
}
