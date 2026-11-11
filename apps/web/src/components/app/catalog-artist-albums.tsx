"use client";

import { useEffect, useState } from "react";
import { externalCatalogPageSchema, type ExternalCatalogItem, type ExternalCatalogPage } from "@mint/client";
import { z } from "zod";

const action = "inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-semibold ring-1 ring-line hover:bg-hover disabled:opacity-40";

async function catalogFetch(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, cache: "no-store", redirect: "error" });
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("The catalog response was too large.");
  const raw: unknown = JSON.parse(text);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(raw);
    throw new Error(error.success ? error.data.error : "The catalog request could not finish.");
  }
  return raw;
}

function CatalogPage({ kind, id, onAlbum, title, onBack }: {
  kind: "artists" | "albums" | "library-albums"; id: string; onAlbum?(album: ExternalCatalogItem): void;
  title?: string; onBack?(): void;
}) {
  const [after, setAfter] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ after: string | null; revision: number; page?: ExternalCatalogPage; error?: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ after: string | null; message: string } | null>(null);
  const current = state?.after === after && state.revision === revision ? state : null;
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "50" });
    if (after) params.set("after", after);
    void catalogFetch(`/api/catalog/${kind}/${id}/${kind === "artists" ? "albums" : "recordings"}?${params}`, { signal: controller.signal })
      .then((raw) => {
        const page = externalCatalogPageSchema.parse(raw);
        if (!controller.signal.aborted) setState({ after, revision, page });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ after, revision, error: error instanceof Error ? error.message : "Catalog unavailable." });
      });
    return () => controller.abort();
  }, [kind, id, after, revision]);
  async function request(recording: ExternalCatalogItem) {
    if (!recording.requestToken || pending) return;
    setPending(recording.id); setOutcome(null);
    try {
      const raw = await catalogFetch("/api/music/search", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: recording.requestToken }),
      });
      const result = z.object({ stage: z.string(), trackId: z.uuid(), needsQueue: z.boolean() }).parse(raw);
      setOutcome({ after, message: ["ready", "analyzing"].includes(result.stage) ?
        "This recording is already indexed. Open Library to choose its playable edition." :
        "Recording requested. It will be available in Library when ready." });
    } catch (error) {
      setOutcome({ after, message: error instanceof Error ? error.message : "This recording could not be requested." });
    } finally { setPending(null); }
  }
  if (current?.page?.configured === false || current?.page?.identityVerified === false) return null;
  const content = <section aria-label={kind === "artists" ? "Catalog albums" : "Catalog album recordings"} aria-busy={!current} className="mt-6 space-y-4">
    {kind === "library-albums" ? <h2 className="text-xl font-semibold">Catalog album recordings</h2> : null}
    <p className="text-sm text-muted">MusicBrainz catalog metadata, separate from playable library songs. Browsing does not download music. Add only music you are authorized to acquire.</p>
    {!current ? <p role="status" className="text-sm text-muted">Loading catalog...</p> : null}
    {current?.error ? <div role="alert"><p>{current.error}</p><button className={action} onClick={() => setRevision((value) => value + 1)}>Try again</button></div> : null}
    {current?.page?.items.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-4 border-b border-line py-3">
      <div className="min-w-0 flex-1"><p className="break-words font-semibold">{item.title}</p>
        <p className="break-words text-sm text-muted">{item.artist} - Catalog {kind === "artists" ? "album" : "recording"}, not playable here</p></div>
      {kind === "artists" ? <button className={action} onClick={() => onAlbum?.(item)}>Browse recordings<span className="sr-only"> for {item.title}</span></button> :
        item.requestToken ? <button className={action} disabled={pending !== null} onClick={() => void request(item)}>
          {pending === item.id ? "Requesting..." : "Add to library"}<span className="sr-only">: {item.title}</span></button> : null}
    </div>)}
    {current?.page?.configured && !current.page.items.length ? <p className="text-sm text-muted">No catalog {kind === "artists" ? "albums" : "recordings"} populated yet.</p> : null}
    {outcome?.after === after ? <p role="status">{outcome.message}</p> : null}
    <div className="flex flex-wrap gap-3">
      {after ? <button className={action} disabled={pending !== null} onClick={() => setAfter(null)}>First catalog page</button> : null}
      {current?.page?.nextCursor ? <button className={action} disabled={pending !== null} onClick={() => setAfter(current.page!.nextCursor)}>More {kind === "artists" ? "albums" : "recordings"}</button> : null}
    </div>
  </section>;
  return title ? <div className="mt-8">
    <h2 className="text-xl font-semibold">{title}</h2>
    {onBack ? <button className={`${action} mt-4`} onClick={onBack}>Back to catalog albums</button> : null}
    {content}
  </div> : content;
}

export function CatalogArtistAlbums({ artistMbid }: { artistMbid: string | null | undefined }) {
  return artistMbid ? <ArtistCatalog key={artistMbid} artistMbid={artistMbid} /> : null;
}

export function CatalogLibraryAlbum({ albumId }: { albumId: string }) {
  return <CatalogPage key={albumId} kind="library-albums" id={albumId} />;
}

function ArtistCatalog({ artistMbid }: { artistMbid: string }) {
  const [album, setAlbum] = useState<ExternalCatalogItem | null>(null);
  return album ? <CatalogPage key={album.id} kind="albums" id={album.id} title={album.title} onBack={() => setAlbum(null)} /> :
    <CatalogPage kind="artists" id={artistMbid} title="Beyond your library" onAlbum={setAlbum} />;
}
