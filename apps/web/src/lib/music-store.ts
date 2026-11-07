import { and, asc, desc, eq, gt, ilike, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@mint/core/db";
import { schema } from "@mint/core/db";
import { PLAYABLE } from "@mint/core/playback";
import { musicCollections as collections, musicEntries as entries, musicMembers as members,
  musicOrganization as organization, musicFolders as folders, musicLikes as likes,
  musicHistory as history, musicPreferences as preferences, musicExclusions as exclusions } from "@mint/core/music-db";
import { MusicError, type HistoryEvent, type MusicMutation, type SmartRules, type createCollectionSchema } from "@mint/core/music";
import { z } from "zod";

type Store = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;
const t = schema.tracks;
export async function playlistLibrarySearch(db: Store, query = "", page = 0) {
  const q = z.string().max(100).parse(query).trim();
  const index = z.number().int().min(0).max(10000).parse(page);
  const match = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const rows = await db.select().from(t).where(and(PLAYABLE,
    ...(q ? [or(ilike(t.title, match), ilike(t.artist, match), ilike(t.album, match))] : [])))
    .orderBy(asc(t.artist), asc(t.title), asc(t.id)).limit(101).offset(index * 100);
  return { tracks: rows.slice(0, 100), nextPage: rows.length > 100 && index < 10000 ? index + 1 : null };
}

export async function collectionAccess(db: Store, userId: string, id: string) {
  const [row] = await db.select().from(collections).where(and(eq(collections.id, id),
    or(eq(collections.ownerId, userId), inArray(collections.id,
      db.select({ id: members.collectionId }).from(members).where(and(eq(members.userId, userId), eq(members.accepted, true))))))).limit(1);
  if (!row) throw new MusicError("Playlist not found or invitation not accepted.", 404);
  return row;
}

export async function listCollections(db: Store, userId: string) {
  const accessible = or(eq(collections.ownerId, userId), inArray(collections.id,
    db.select({ id: members.collectionId }).from(members).where(and(eq(members.userId, userId), eq(members.accepted, true)))));
  const [rows, folderRows, invites] = await Promise.all([
    db.select({ collection: collections, pinned: organization.pinned, folderId: organization.folderId })
      .from(collections).leftJoin(organization, and(eq(organization.collectionId, collections.id), eq(organization.userId, userId)))
      .where(accessible).orderBy(desc(sql`coalesce(${organization.pinned},false)`), asc(collections.title)),
    db.select().from(folders).where(eq(folders.userId, userId)).orderBy(asc(folders.title)),
    db.select({ id: collections.id, title: collections.title, owner: schema.users.name }).from(members)
      .innerJoin(collections, eq(collections.id, members.collectionId)).innerJoin(schema.users, eq(schema.users.id, collections.ownerId))
      .where(and(eq(members.userId, userId), eq(members.accepted, false))),
  ]);
  return { collections: rows.map((r) => ({ ...r.collection, pinned: r.pinned ?? false, folderId: r.folderId,
    role: r.collection.ownerId === userId ? "owner" as const : "editor" as const })), folders: folderRows, invitations: invites };
}

export async function smartTracks(db: Store, userId: string, rules: SmartRules) {
  const conditions: (SQL | undefined)[] = [PLAYABLE];
  const contains = (value: string) => `%${value.replace(/[%_\\]/g, "\\$&")}%`;
  if (rules.artist) conditions.push(ilike(t.artist, contains(rules.artist)));
  if (rules.album) conditions.push(ilike(t.album, contains(rules.album)));
  if (rules.title) conditions.push(ilike(t.title, contains(rules.title)));
  if (rules.codec) conditions.push(sql`lower(coalesce(${t.codec},${t.existingCodec},'')) = ${rules.codec.toLowerCase()}`);
  const liked = db.select({ id: likes.trackId }).from(likes).where(eq(likes.userId, userId));
  if (rules.liked !== undefined) conditions.push(rules.liked ? inArray(t.id, liked) : notInArray(t.id, liked));
  if (rules.neverPlayed) conditions.push(notInArray(t.id, db.select({ id: history.trackId }).from(history).where(eq(history.userId, userId))));
  if (rules.minYear) conditions.push(sql`${t.year} >= ${rules.minYear}`);
  if (rules.maxYear) conditions.push(sql`${t.year} <= ${rules.maxYear}`);
  if (rules.addedWithinDays) conditions.push(sql`${t.createdAt} >= now() - ${rules.addedWithinDays} * interval '1 day'`);
  if (rules.genre?.trim()) {
    const g = rules.genre.trim().toLowerCase();
    conditions.push(sql`exists (
      select 1 from track_analysis ta, jsonb_array_elements(coalesce(ta.result->'classification'->'genres', '[]'::jsonb)) item
      where ta.track_id = ${t.id} and ta.result is not null
        and (lower(coalesce(item->>'name', '')) = ${g} or lower(coalesce(item->>'subgenre', '')) = ${g})
    )`);
  }
  if (rules.mood?.trim()) {
    const m = rules.mood.trim().toLowerCase();
    conditions.push(sql`exists (
      select 1 from track_analysis ta, jsonb_array_elements(coalesce(ta.result->'classification'->'moods', '[]'::jsonb)) item
      where ta.track_id = ${t.id} and ta.result is not null
        and lower(coalesce(item->>'name', '')) = ${m}
    )`);
  }
  if (rules.minBpm !== undefined) {
    conditions.push(sql`exists (
      select 1 from track_analysis ta
      where ta.track_id = ${t.id} and ta.result is not null
        and (ta.result->'tempo'->>'bpm') is not null
        and (ta.result->'tempo'->>'bpm')::double precision >= ${rules.minBpm}
    )`);
  }
  if (rules.maxBpm !== undefined) {
    conditions.push(sql`exists (
      select 1 from track_analysis ta
      where ta.track_id = ${t.id} and ta.result is not null
        and (ta.result->'tempo'->>'bpm') is not null
        and (ta.result->'tempo'->>'bpm')::double precision <= ${rules.maxBpm}
    )`);
  }
  if (rules.camelotKey?.trim()) {
    const kUpper = rules.camelotKey.trim().toUpperCase();
    const kLower = rules.camelotKey.trim().toLowerCase();
    conditions.push(sql`exists (
      select 1 from track_analysis ta
      where ta.track_id = ${t.id} and ta.result is not null
        and (upper(coalesce(ta.result->'key'->>'camelot', '')) = ${kUpper} or lower(coalesce(ta.result->'key'->>'name', '')) = ${kLower})
    )`);
  }
  if (rules.vocalType) {
    conditions.push(sql`exists (
      select 1 from track_analysis ta
      where ta.track_id = ${t.id} and ta.result is not null
        and lower(coalesce(ta.result->'classification'->'voiceInstrumental'->>'label', '')) = ${rules.vocalType.toLowerCase()}
    )`);
  }
  const order = rules.order === "newest" ? [desc(t.createdAt)] : rules.order === "least-played"
    ? [asc(sql`(select count(*) from music_history h where h.track_id = ${t.id} and h.user_id = ${userId})`)] : [asc(t.artist), asc(t.title)];
  return db.select().from(t).where(and(...conditions)).orderBy(...order, asc(t.id)).limit(rules.limit);
}

export async function collectionDetail(db: Store, userId: string, id: string) {
  const collection = await collectionAccess(db, userId, id);
  // Smart rules belong to the owner; collaborators see the same resulting playlist.
  const rows = collection.rules
    ? (await smartTracks(db, collection.ownerId, collection.rules)).map((track, i) => ({ entryId: track.id, position: i, track }))
    : await db.select({ entryId: entries.id, position: entries.position, track: t }).from(entries)
      .innerJoin(t, eq(t.id, entries.trackId)).where(eq(entries.collectionId, id)).orderBy(asc(entries.position), asc(entries.id));
  const collaborators = collection.ownerId === userId ? await db.select({ userId: members.userId, accepted: members.accepted, name: schema.users.name, email: schema.users.email })
    .from(members).innerJoin(schema.users, eq(schema.users.id, members.userId)).where(eq(members.collectionId, id)) : [];
  return { ...collection, role: collection.ownerId === userId ? "owner" as const : "editor" as const, entries: rows, collaborators };
}

async function validateTracks(db: Store, ids: string[]) {
  if (!ids.length) return;
  const found = await db.select({ id: t.id }).from(t).where(inArray(t.id, [...new Set(ids)]));
  if (found.length !== new Set(ids).size) throw new MusicError("One or more songs no longer exist. Reload and try again.");
}
export async function createCollection(db: Db, userId: string, input: z.infer<typeof createCollectionSchema>) {
  return db.transaction(async (tx) => {
    let trackIds = input.trackIds;
    if (input.sourceCollectionId) trackIds = (await collectionDetail(tx, userId, input.sourceCollectionId)).entries.map((e) => e.track.id);
    if (input.sourcePlaylistId) {
      const [source] = await tx.select().from(schema.playlists).where(and(eq(schema.playlists.id, input.sourcePlaylistId), eq(schema.playlists.userId, userId))).limit(1);
      if (!source) throw new MusicError("Source playlist not found.", 404);
      trackIds = (await tx.select({ id: schema.playlistTracks.trackId }).from(schema.playlistTracks)
        .where(eq(schema.playlistTracks.playlistId, source.id)).orderBy(asc(schema.playlistTracks.position))).map((r) => r.id);
    }
    if (input.rules && trackIds.length) throw new MusicError("Smart playlists use rules instead of fixed entries.");
    if (trackIds.length > 5000) throw new MusicError("Mint playlists support up to 5,000 entries. Copy a smaller selection.");
    await validateTracks(tx, trackIds);
    const [row] = await tx.insert(collections).values({ ownerId: userId, title: input.title, description: input.description, rules: input.rules }).returning();
    if (trackIds.length) await tx.insert(entries).values(trackIds.map((trackId, position) => ({ collectionId: row!.id, trackId, position })));
    return row!;
  });
}

export async function mutateCollection(db: Db, userId: string, id: string, input: MusicMutation) {
  return db.transaction(async (tx) => {
    const original = await collectionAccess(tx, userId, id);
    if (["delete", "invite", "revoke"].includes(input.action) && original.ownerId !== userId) throw new MusicError("Only the owner can manage access or delete this playlist.", 403);
    const [row] = await tx.update(collections).set({ revision: sql`${collections.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(collections.id, id), eq(collections.revision, input.revision))).returning();
    if (!row) throw new MusicError("This playlist changed in another session. Reload it before saving your changes.", 409);
    // Re-check access after acquiring the playlist row lock: a concurrent owner may have revoked it.
    await collectionAccess(tx, userId, id);
    if (input.action === "update") {
      const { action: _, revision: __, ...patch } = input;
      if (original.rules && input.rules === null) throw new MusicError("Duplicate a smart playlist to make an editable snapshot.");
      if (!original.rules && input.rules) {
        await tx.delete(entries).where(eq(entries.collectionId, id));
      }
      await tx.update(collections).set({ ...patch, ...(patch.artworkUrl === "" ? { artworkUrl: null } : {}) }).where(eq(collections.id, id));
    } else if (input.action === "append") {
      if (row.rules) throw new MusicError("Edit the smart rules instead of adding songs.");
      await validateTracks(tx, input.trackIds);
      const [last] = await tx.select({ position: sql<number>`coalesce(max(${entries.position}),-1)::int`, count: sql<number>`count(*)::int` }).from(entries).where(eq(entries.collectionId, id));
      if ((last?.count ?? 0) + input.trackIds.length > 5000) throw new MusicError("Mint playlists support up to 5,000 entries. Create another playlist for more songs.");
      await tx.insert(entries).values(input.trackIds.map((trackId, i) => ({ collectionId: id, trackId, position: (last?.position ?? -1) + i + 1 })));
    } else if (input.action === "remove") {
      const removed = await tx.delete(entries).where(and(eq(entries.id, input.entryId), eq(entries.collectionId, id))).returning();
      if (!removed.length) throw new MusicError("That entry no longer exists.", 404);
    } else if (input.action === "reorder") {
      const current = await tx.select({ id: entries.id }).from(entries).where(eq(entries.collectionId, id));
      if (new Set(input.entryIds).size !== current.length || input.entryIds.length !== current.length || current.some((e) => !input.entryIds.includes(e.id))) throw new MusicError("Reload the playlist before reordering.");
      for (const [position, entryId] of input.entryIds.entries()) await tx.update(entries).set({ position }).where(and(eq(entries.id, entryId), eq(entries.collectionId, id)));
    } else if (input.action === "delete") {
      await tx.delete(collections).where(eq(collections.id, id));
    } else if (input.action === "invite") {
      const [user] = await tx.select({ id: schema.users.id }).from(schema.users).where(and(sql`lower(${schema.users.email}) = ${input.email.toLowerCase()}`, eq(schema.users.status, "active"))).limit(1);
      if (!user || user.id === userId) throw new MusicError("Enter another approved Mint member's email.");
      await tx.insert(members).values({ collectionId: id, userId: user.id }).onConflictDoNothing();
    } else if (input.action === "revoke") {
      await tx.delete(members).where(and(eq(members.collectionId, id), eq(members.userId, input.userId)));
    }
    return { id, revision: row.revision };
  });
}

export async function respondInvitation(db: Db, userId: string, id: string, accept: boolean) {
  const where = and(eq(members.collectionId, id), eq(members.userId, userId), eq(members.accepted, false));
  const rows = accept ? await db.update(members).set({ accepted: true }).where(where).returning()
    : await db.delete(members).where(where).returning();
  if (!rows.length) throw new MusicError("Invitation not found.", 404);
}

export async function organizeCollection(db: Db, userId: string, id: string, input: { folderId: string | null; pinned: boolean }) {
  await collectionAccess(db, userId, id);
  if (input.folderId) {
    const [folder] = await db.select().from(folders).where(and(eq(folders.id, input.folderId), eq(folders.userId, userId)));
    if (!folder) throw new MusicError("Folder not found.", 404);
  }
  await db.insert(organization).values({ collectionId: id, userId, ...input })
    .onConflictDoUpdate({ target: [organization.collectionId, organization.userId], set: input });
}
export async function recordHistory(db: Db, userId: string, input: HistoryEvent) {
  return db.transaction(async (tx) => {
    await tx.insert(preferences).values({ userId }).onConflictDoNothing();
    const [pref] = await tx.select().from(preferences).where(eq(preferences.userId, userId)).for("update");
    if (pref?.privateSession || input.listenedMs < 1000) return { recorded: false };
    if (input.startedAt && new Date(input.startedAt).getTime() > Date.now()) throw new MusicError("Listening episode cannot start in the future.");
    // Discard episodes crossing a privacy boundary, including events queued by another tab.
    if (pref?.historyAfter && (!input.startedAt || new Date(input.startedAt) < pref.historyAfter)) return { recorded: false };
    const [track] = await tx.select({ id: t.id, duration: t.durationSec, existingDuration: t.existingDurationSec }).from(t).where(and(eq(t.id, input.trackId), PLAYABLE)).limit(1);
    if (!track) throw new MusicError("Playable song not found.", 404);
    const durationMs = (track.duration ?? track.existingDuration ?? 86_400) * 1000;
    const rows = await tx.insert(history).values({ id: input.eventId, userId, trackId: input.trackId,
      listenedMs: Math.min(input.listenedMs, durationMs), completed: input.completed && input.listenedMs >= durationMs * 0.8 }).onConflictDoNothing().returning();
    return { recorded: rows.length > 0 };
  });
}
export async function setPrivateSession(db: Db, userId: string, privateSession: boolean) {
  const historyAfter = new Date();
  await db.insert(preferences).values({ userId, privateSession, historyAfter }).onConflictDoUpdate({ target: preferences.userId, set: { privateSession, historyAfter } });
}
export async function deleteHistory(db: Db, userId: string, eventId?: string) {
  return db.transaction(async (tx) => {
    // Sharing the recording lock prevents delayed/retried episodes from restoring deleted history.
    const historyAfter = new Date();
    await tx.insert(preferences).values({ userId, historyAfter }).onConflictDoUpdate({ target: preferences.userId, set: { historyAfter } });
    await tx.delete(history).where(and(eq(history.userId, userId), ...(eventId ? [eq(history.id, eventId)] : [])));
  });
}
export async function musicProfile(db: Store, userId: string) {
  const [pref, liked, excluded] = await Promise.all([
    db.select().from(preferences).where(eq(preferences.userId, userId)),
    db.select({ trackId: likes.trackId }).from(likes).where(eq(likes.userId, userId)),
    db.select({ trackId: exclusions.trackId }).from(exclusions).where(eq(exclusions.userId, userId)),
  ]);
  return { privateSession: pref[0]?.privateSession ?? false, likes: liked.map((r) => r.trackId), exclusions: excluded.map((r) => r.trackId) };
}

const importedLikesCursorSchema = z.object({ likedAt: z.iso.datetime(), trackId: z.uuid() });
export function parseImportedLikesCursor(cursor?: string | null) {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 256) throw new Error("Cursor too long");
    return importedLikesCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new MusicError("Invalid imported favorites page.");
  }
}

export async function importedLikeCandidates(db: Store, userId: string, cursor?: string | null) {
  const position = parseImportedLikesCursor(cursor);
  const nativeLikes = db.select({ id: likes.trackId }).from(likes).where(eq(likes.userId, userId));
  const rows = await db.select({ track: t,
    likedAt: sql<string>`to_char(${schema.userTracks.likedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(schema.userTracks)
    .innerJoin(t, eq(t.id, schema.userTracks.trackId))
    .where(and(eq(schema.userTracks.userId, userId), eq(schema.userTracks.origin, "youtube"), notInArray(t.id, nativeLikes),
      position ? or(sql`${schema.userTracks.likedAt} < ${position.likedAt}::timestamptz`,
        and(sql`${schema.userTracks.likedAt} = ${position.likedAt}::timestamptz`, gt(t.id, position.trackId))) : undefined))
    .orderBy(desc(schema.userTracks.likedAt), asc(t.id)).limit(101);
  const last = rows[99];
  return {
    tracks: rows.slice(0, 100).map((row) => row.track),
    nextCursor: rows.length > 100 && last
      ? Buffer.from(JSON.stringify({ likedAt: last.likedAt, trackId: last.track.id })).toString("base64url")
      : null,
  };
}
