import type { TrackView } from "@mint/core/events";

const ROWS = 3;
const PER_ROW = 14;

/**
 * Hero backdrop built only from covers already in the library. Each row is doubled so
 * the -50% drift loops seamlessly; reduced motion freezes it in place.
 */
export function ArtWall({ tracks }: { tracks: Pick<TrackView, "id" | "artworkUrl">[] }) {
  const covers = tracks.filter((t) => t.artworkUrl);
  if (covers.length < 3) return null;
  const rows = Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: PER_ROW }, (_, i) => covers[(r * 5 + i * (r + 1)) % covers.length]!),
  );
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className="absolute inset-x-0 -top-6 flex -rotate-[4deg] flex-col gap-3 sm:-top-10 sm:gap-4">
        {rows.map((row, r) => (
          <div
            key={r}
            className="drift flex w-max gap-3 sm:gap-4"
            data-reverse={r % 2 ? "" : undefined}
            style={{ "--drift-duration": `${150 + r * 40}s` } as React.CSSProperties}
          >
            {[...row, ...row].map((t, i) => (
              <img
                key={`${t.id}-${i}`}
                src={t.artworkUrl}
                alt=""
                loading={i < 8 ? "eager" : "lazy"}
                decoding="async"
                referrerPolicy="no-referrer"
                className="size-36 rounded-md bg-elevated object-cover sm:size-52 lg:size-60"
              />
            ))}
          </div>
        ))}
      </div>
      {/* Scrim keeps the headline at full contrast over any cover. */}
      <div className="absolute inset-0 bg-[linear-gradient(90deg,var(--color-bg)_0%,color-mix(in_oklab,var(--color-bg)_88%,transparent)_45%,color-mix(in_oklab,var(--color-bg)_45%,transparent)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-bg to-transparent" />
    </div>
  );
}
