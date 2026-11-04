"use server";

import { getDb } from "@mint/core/db";
import { spotifyAccounts } from "@mint/core/spotify-db";
import { disconnectSpotifyAccount, importSpotifyPlaylist, setSpotifyPlaylistSelection, spotifyAccountView, spotifyPlayableQuery } from "@mint/core/spotify-store";
import { parseSpotifyPlaylistId, SpotifyError, spotifyConfigured } from "@mint/core/spotify";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { enqueueSpotifySync } from "@/lib/spotify-queue";
import { createCollection } from "@/lib/music-store";

export async function syncSpotifyNow(): Promise<{ error?: string }> {
  const user = await requireUser(), db = getDb();
  if (!spotifyConfigured()) return { error: "Ask the server operator to configure Spotify first." };
  const account = await spotifyAccountView(db, user.id);
  if (!account) return { error: "Connect Spotify first." };
  if (account.status === "reconnect") return { error: "Reconnect Spotify to restore read permissions." };
  if (account.status === "rate_limited" && account.nextSyncAt > new Date()) return { error: "Spotify cooldown is active. Wait until the retry time." };
  if (!await rateLimit(`spotify-sync:${user.id}`, 6, 600)) return { error: "A sync was just requested. Give the worker a few minutes." };
  try { await enqueueSpotifySync(user.id); } catch { return { error: "The sync queue is unavailable. Try again shortly." }; }
  revalidatePath("/app/spotify");
  return {};
}

export async function addSpotifyPlaylist(_previous: { error?: string; success?: string }, form: FormData): Promise<{ error?: string; success?: string }> {
  const user = await requireUser();
  if (!await rateLimit(`spotify-import:${user.id}`, 12, 600)) return { error: "Too many imports. Try again in a few minutes." };
  try {
    const value = z.string().max(2048).parse(form.get("playlist"));
    await importSpotifyPlaylist(getDb(), user.id, parseSpotifyPlaylistId(value));
  } catch (error) { return { error: error instanceof SpotifyError ? error.message : "Could not import that playlist. Check the link and account connection." }; }
  try { await enqueueSpotifySync(user.id); } catch { return { error: "Playlist selected, but the queue is unavailable. Use Sync now when the worker is back." }; }
  revalidatePath("/app/spotify");
  return { success: "Playlist selected. The worker will match it against the local Plex library." };
}

export async function selectSpotifyPlaylist(id: string, enabled: boolean): Promise<{ error?: string }> {
  const user = await requireUser();
  z.uuid().parse(id);
  try { await setSpotifyPlaylistSelection(getDb(), user.id, id, enabled); }
  catch (error) { return { error: error instanceof SpotifyError ? error.message : "Could not save your Spotify selection. Try again." }; }
  revalidatePath("/app/spotify");
  if (enabled) return syncSpotifyNow();
  return {};
}

export async function setSpotifyAutoSync(form: FormData) {
  const user = await requireUser();
  await getDb().update(spotifyAccounts).set({ autoSync: form.get("autoSync") === "on" }).where(eq(spotifyAccounts.userId, user.id));
  revalidatePath("/app/spotify");
}

export async function unlinkSpotify() {
  const user = await requireUser();
  await disconnectSpotifyAccount(getDb(), user.id);
  revalidatePath("/app/spotify");
  revalidatePath("/app/settings");
}

export async function copySpotifyToMint(id: string): Promise<{ error?: string; id?: string }> {
  const user = await requireUser();
  z.uuid().parse(id);
  if (!await rateLimit(`spotify-copy:${user.id}`, 12, 600)) return { error: "Too many copies. Try again in a few minutes." };
  const db = getDb(), source = await spotifyPlayableQuery(db, user.id, id);
  if (!source) return { error: "That Spotify source is no longer available." };
  if (!source.total) return { error: "Sync this playlist and match some local songs before copying." };
  if (source.total > 5_000) return { error: "Editable Mint playlists support up to 5,000 songs. This source has too many local matches to copy." };
  try {
    const rows = await db.execute(source.query);
    const copy = await createCollection(db, user.id, { title: `${source.title} (copy)`.slice(0, 200),
      description: "An editable snapshot of local matches from a Spotify source playlist. Missing songs were skipped; future Spotify syncs will not change this copy.",
      rules: null, trackIds: rows.rows.map((r) => String(r.track_id)) });
    revalidatePath("/app/collections");
    return { id: copy.id };
  } catch { return { error: "Could not create an editable copy. Refresh the source and try again." }; }
}
