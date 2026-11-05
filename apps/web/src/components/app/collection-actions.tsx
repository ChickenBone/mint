"use client";

import Link from "next/link";
import { Download, Play, Shuffle } from "lucide-react";
import { collectionParams } from "@/lib/browser-catalog";
import type { PlayerCollection } from "@/lib/player-protocol";
import { Menu, type MenuItem } from "@/components/ui/interactive";
import { usePlayer } from "./player";

export function CollectionActions({
  collection,
  empty = false,
  label = "library",
  title,
  showDownload = true,
  menuItems,
  menuLabel = "More actions",
}: {
  collection: PlayerCollection;
  empty?: boolean;
  label?: string;
  title?: string;
  showDownload?: boolean;
  menuItems?: MenuItem[];
  menuLabel?: string;
}) {
  const player = usePlayer();
  if (!player) return null;
  const downloadQuery = collectionParams(collection);
  downloadQuery.set("tab", "downloads");
  if (title) downloadQuery.set("title", title);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-busy={player.busy}
        disabled={!player.ready || player.busy || empty}
        onClick={() => player.command({ action: "collection", collection, shuffle: false })}
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-5 py-2.5 text-sm font-bold text-mint-ink hover:bg-mint-strong disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Play className="size-4" fill="currentColor" aria-hidden />
        {player.busy ? "Loading music…" : `Play ${label}`}
      </button>
      <button
        type="button"
        disabled={!player.ready || player.busy || empty}
        onClick={() => player.command({ action: "collection", collection, shuffle: true })}
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 py-2.5 text-sm font-semibold text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Shuffle className="size-4" aria-hidden />
        Shuffle
      </button>
      {showDownload && (
        <Link
          href={`/app/collection?${downloadQuery.toString()}`}
          aria-disabled={empty || undefined}
          className={`inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 py-2.5 text-sm font-semibold text-fg hover:bg-hover ${empty ? "pointer-events-none opacity-40" : ""}`}
        >
          <Download className="size-4" aria-hidden />
          Download
        </Link>
      )}
      {menuItems && menuItems.length > 0 && <Menu label={menuLabel} items={menuItems} />}
    </div>
  );
}
