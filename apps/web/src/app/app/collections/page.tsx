import { getDb, schema } from "@mint/core/db";
import { eq, asc } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { listCollections } from "@/lib/music-store";
import { NativeCollections } from "@/components/app/native-collections";

export default async function CollectionsPage() {
  const user = await requireUser(), db = getDb();
  const [initial, sources] = await Promise.all([listCollections(db, user.id), db.select({ id: schema.playlists.id, title: schema.playlists.title })
    .from(schema.playlists).where(eq(schema.playlists.userId, user.id)).orderBy(asc(schema.playlists.title))]);
  return <NativeCollections initial={initial} sources={sources} />;
}
