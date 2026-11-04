import { getDb } from "@mint/core/db";
import { toTrackView } from "@mint/core/views";
import { UUID } from "@mint/core/playback";
import { MusicError } from "@mint/core/music";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { collectionDetail } from "@/lib/music-store";
import { NativeCollectionEditor } from "@/components/app/native-collection-editor";

export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(), { id } = await params;
  if (!UUID.test(id)) notFound();
  const detail = await collectionDetail(getDb(), user.id, id).catch((error: unknown) => {
    if (error instanceof MusicError && error.status === 404) notFound();
    throw error;
  });
  return <NativeCollectionEditor initial={{ ...detail, entries: detail.entries.map((e) => ({ ...e, track: toTrackView(e.track) })) }} />;
}
