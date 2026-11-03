import type { TrackView } from "@mint/core/events";
import { Artwork } from "./artwork";

const ROWS = 4;
const PER_ROW = 14;

/**
 * Hero backdrop built only from covers already in the library. Each row is doubled so
 * the -50% drift loops seamlessly; reduced motion freezes it in place.
 */
export function ArtWall({ tracks }: { tracks: Pick<TrackView, "artworkUrl">[] }) {
  const covers = tracks.filter((t) => t.artworkUrl);
  if (!covers.length) return null;
  const rows = Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: PER_ROW }, (_, i) => covers[(r * 5 + i * (r + 1)) % covers.length]!),
  );
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden data-artwork-wall>
      <div className="absolute inset-x-0 -top-6 flex -rotate-[4deg] flex-col gap-3 sm:-top-10 sm:gap-4">
        {rows.map((row, r) => (
          <div
            key={r}
            className="drift flex w-max"
            data-reverse={r % 2 ? "" : undefined}
            style={{ "--drift-duration": `${150 + r * 40}s` } as React.CSSProperties}
          >
            {[0, 1].map((copy) => <div key={copy} className="flex shrink-0 gap-3 pr-3 sm:gap-4 sm:pr-4">
              {row.map((track, i) => <Artwork key={`${track.artworkUrl}-${i}`} track={track} eager={copy === 0 && i < 8} className="size-40 sm:size-52 lg:size-60" />)}
            </div>)}
          </div>
        ))}
      </div>
      {/* Scrim keeps the headline at full contrast over any cover. */}
      <div className="absolute inset-0 bg-bg/85 sm:bg-transparent sm:bg-[linear-gradient(90deg,var(--color-bg)_0%,color-mix(in_oklab,var(--color-bg)_88%,transparent)_45%,color-mix(in_oklab,var(--color-bg)_45%,transparent)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-bg to-transparent" />
    </div>
  );
}
