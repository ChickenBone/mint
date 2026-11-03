import { and, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import { getDb, schema } from "./db/index";

export const PLAYABLE = and(
  inArray(schema.tracks.stage, ["ready", "analyzing"]),
  or(isNotNull(schema.tracks.filePath), isNotNull(schema.tracks.existingFilePath)),
);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function activePlaybackSession(sessionHash: string, userId: string) {
  if (!UUID.test(userId) || !/^[0-9a-f]{64}$/.test(sessionHash)) return null;
  const [session] = await getDb().select({ userId: schema.users.id, name: schema.users.name })
    .from(schema.sessions).innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.id, sessionHash), gt(schema.sessions.expiresAt, new Date()),
      eq(schema.users.status, "active"), eq(schema.users.id, userId))).limit(1);
  return session ?? null;
}

export interface PlaybackClaim { userId: string; sessionHash: string; trackId: string }
