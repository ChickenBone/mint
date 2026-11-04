"use server";

import { getDb, schema } from "@mint/core/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { enqueueRetry, enqueueSync } from "@/lib/queues";
import { rateLimit } from "@/lib/rate-limit";

export async function syncNow(): Promise<{ error?: string }> {
  const user = await requireUser();
  if (!(await rateLimit(`sync:${user.id}`, 6, 600))) return { error: "Sync was just run. Give it a few minutes." };
  const acct = await getDb().query.youtubeAccounts.findFirst({ where: eq(schema.youtubeAccounts.userId, user.id), columns: { userId: true } });
  if (!acct) return { error: "Link YouTube Music first." };
  await enqueueSync(user.id, "manual");
  return {};
}

export async function updateSyncSettings(form: FormData) {
  const user = await requireUser();
  await getDb()
    .update(schema.youtubeAccounts)
    .set({ musicOnly: form.get("musicOnly") === "on", autoSync: form.get("autoSync") === "on" })
    .where(eq(schema.youtubeAccounts.userId, user.id));
  revalidatePath("/app/settings");
}

export async function setPlaylistSync(playlistId: string, enabled: boolean) {
  const user = await requireUser();
  z.uuid().parse(playlistId);
  await getDb()
    .update(schema.playlists)
    .set({ syncEnabled: enabled })
    .where(and(eq(schema.playlists.id, playlistId), eq(schema.playlists.userId, user.id)));
  if (enabled) await enqueueSync(user.id, "manual");
  revalidatePath("/app", "layout");
}

export async function retryTrack(trackId: string, forceCobalt = false): Promise<{ error?: string }> {
  const user = await requireUser();
  z.uuid().parse(trackId);
  const db = getDb();
  if (user.role !== "admin") {
    const owns = await db.query.userTracks.findFirst({
      where: and(eq(schema.userTracks.userId, user.id), eq(schema.userTracks.trackId, trackId)),
    });
    if (!owns) return { error: "You can only retry songs in your own library." };
  }
  if (!(await rateLimit(`retry:${user.id}`, 60, 600))) return { error: "Too many retries. Slow down a little." };
  await db
    .update(schema.tracks)
    .set({ stage: "queued", progress: 0, error: null, detail: forceCobalt ? "Retrying via YouTube" : "Retrying", filePath: null })
    .where(eq(schema.tracks.id, trackId));
  await enqueueRetry(trackId, forceCobalt, user.id);
  return {};
}

export async function unlinkYoutube() {
  const user = await requireUser();
  await getDb().delete(schema.youtubeAccounts).where(eq(schema.youtubeAccounts.userId, user.id));
  revalidatePath("/app", "layout");
}
