import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@mint/core/db";
import { musicFolders, musicHistory, musicLikes, musicExclusions } from "@mint/core/music-db";
import { collectionMutationSchema, createCollectionSchema, historyEventSchema, MusicError } from "@mint/core/music";
import { getUser } from "@/lib/auth";
import { boundedJson, publicUrl } from "@/lib/request";
import { collectionDetail, createCollection, deleteHistory, listCollections, musicProfile, mutateCollection,
  importedLikeCandidates, organizeCollection, playlistLibrarySearch, recordHistory, respondInvitation, setPrivateSession } from "@/lib/music-store";
import { discoverMusic } from "@/lib/music-discovery";
import { trackPlayerItem } from "@/lib/player-protocol";
import { toTrackView } from "@mint/core/views";
import { validConsumerMutation } from "@/lib/native-context";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const uuid = (id: string | undefined) => z.uuid().parse(id);
async function handle(request: Request, context: Context) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required." }, 401);
  try {
    const url = new URL(request.url), method = request.method;
    if (method !== "GET") {
      if (!validConsumerMutation(request, publicUrl())) throw new MusicError("Request origin not allowed.", 403);
    }
    const body = async () => {
      if (!request.headers.get("content-type")?.includes("application/json")) throw new MusicError("Send a JSON request.");
      try {
        return await boundedJson(request, 200_000);
      } catch (error) { throw new MusicError(error instanceof Error ? error.message : "The request is not valid JSON."); }
    };
    const path = (await context.params).path;
    const [resource, id, action] = path;
    const db = getDb();
    if (resource === "collections") {
      if (!id && method === "GET") return json(await listCollections(db, user.id));
      if (!id && method === "POST") return json(await createCollection(db, user.id, createCollectionSchema.parse(await body())), 201);
      uuid(id);
      if (!action && method === "GET") {
        const detail = await collectionDetail(db, user.id, id!);
        return json({ ...detail, entries: detail.entries.map((e) => ({ ...e, track: toTrackView(e.track) })) });
      }
      if (!action && method === "PATCH") return json(await mutateCollection(db, user.id, id!, collectionMutationSchema.parse(await body())));
      if (action === "invitation" && method === "POST") {
        await respondInvitation(db, user.id, id!, z.object({ accept: z.boolean() }).parse(await body()).accept);
        return json({ ok: true });
      }
      if (action === "organization" && method === "PATCH") {
        await organizeCollection(db, user.id, id!, z.object({ pinned: z.boolean(), folderId: z.uuid().nullable() }).parse(await body()));
        return json({ ok: true });
      }
    } else if (resource === "folders") {
      if (!id && method === "POST") {
        const { title } = z.object({ title: z.string().trim().min(1).max(100) }).parse(await body());
        return json((await db.insert(musicFolders).values({ userId: user.id, title }).returning())[0], 201);
      }
      uuid(id);
      if (method === "PATCH") {
        const { title } = z.object({ title: z.string().trim().min(1).max(100) }).parse(await body());
        const rows = await db.update(musicFolders).set({ title }).where(and(eq(musicFolders.id, id!), eq(musicFolders.userId, user.id))).returning();
        if (!rows.length) throw new MusicError("Folder not found.", 404);
        return json(rows[0]);
      }
      if (method === "DELETE") {
        await db.delete(musicFolders).where(and(eq(musicFolders.id, id!), eq(musicFolders.userId, user.id)));
        return json({ ok: true });
      }
    } else if (resource === "preferences") {
      if (method === "GET") return json(await musicProfile(db, user.id));
      if (method === "PATCH") {
        await setPrivateSession(db, user.id, z.object({ privateSession: z.boolean() }).parse(await body()).privateSession);
        return json(await musicProfile(db, user.id));
      }
    } else if (resource === "history") {
      if (method === "POST") return json(await recordHistory(db, user.id, historyEventSchema.parse(await body())));
      if (method === "GET") {
        const page = z.coerce.number().int().min(0).max(10000).parse(url.searchParams.get("page") ?? 0);
        const rows = await db.select({ event: musicHistory, track: schema.tracks }).from(musicHistory)
          .innerJoin(schema.tracks, eq(schema.tracks.id, musicHistory.trackId)).where(eq(musicHistory.userId, user.id))
          .orderBy(desc(musicHistory.createdAt), desc(musicHistory.id)).limit(101).offset(page * 100);
        return json({ entries: rows.map((r) => ({ ...r, track: toTrackView(r.track) })) });
      }
      if (method === "DELETE") {
        await deleteHistory(db, user.id, id ? uuid(id) : undefined);
        return json({ ok: true });
      }
    } else if (resource === "likes") {
      if (id === "imported" && method === "GET") {
        const result = await importedLikeCandidates(db, user.id, url.searchParams.get("cursor"));
        return json({ tracks: result.tracks.map(toTrackView), nextCursor: result.nextCursor });
      }
      if (method === "GET") {
        const rows = await db.select({ track: schema.tracks }).from(musicLikes)
          .innerJoin(schema.tracks, eq(schema.tracks.id, musicLikes.trackId)).where(eq(musicLikes.userId, user.id)).orderBy(desc(musicLikes.createdAt)).limit(1000);
        return json({ tracks: rows.map((r) => ({ track: toTrackView(r.track) })) });
      }
      uuid(id);
      if (method === "PUT") {
        const [track] = await db.select({ id: schema.tracks.id }).from(schema.tracks).where(eq(schema.tracks.id, id!)).limit(1);
        if (!track) throw new MusicError("Song not found.", 404);
        await db.insert(musicLikes).values({ userId: user.id, trackId: id! }).onConflictDoNothing();
        return json({ ok: true });
      }
      if (method === "DELETE") {
        await db.delete(musicLikes).where(and(eq(musicLikes.userId, user.id), eq(musicLikes.trackId, id!)));
        return json({ ok: true });
      }
    } else if (resource === "exclusions") {
      uuid(id);
      if (method === "PUT") {
        await db.insert(musicExclusions).values({ userId: user.id, trackId: id! }).onConflictDoNothing();
        return json({ ok: true });
      }
      if (method === "DELETE") {
        await db.delete(musicExclusions).where(and(eq(musicExclusions.userId, user.id), eq(musicExclusions.trackId, id!)));
        return json({ ok: true });
      }
    } else if (resource === "discover" && method === "GET") {
      const mode = z.enum(["for-you", "recent", "rediscover", "radio", "sonic"]).parse(url.searchParams.get("mode") ?? "for-you");
      const seeds = z.array(z.uuid()).max(20).parse(url.searchParams.getAll("seed"));
      const result = await discoverMusic(db, user.id, mode, seeds);
      return json({ ...result, items: result.items.map(({ track, reason }) => ({ track: toTrackView(track), item: trackPlayerItem(toTrackView(track)), reason })) });
    } else if (resource === "library" && method === "GET") {
      const page = z.coerce.number().int().min(0).max(10000).parse(url.searchParams.get("page") ?? 0);
      const result = await playlistLibrarySearch(db, url.searchParams.get("q") ?? "", page);
      return json({ tracks: result.tracks.map(toTrackView), nextPage: result.nextPage });
    }
    return json({ error: "Music endpoint not found." }, 404);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: error.issues[0]?.message ?? "Invalid music request." }, 400);
    if (error instanceof MusicError) return json({ error: error.message }, error.status);
    console.error("Music request failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Your music could not be saved or loaded. Check the connection and try again." }, 503);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
