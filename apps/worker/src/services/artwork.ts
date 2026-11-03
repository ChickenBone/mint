import { HttpError, httpJson } from "../http";
import { albumReleaseGroups } from "./musicbrainz";

interface ArchiveImage {
  front: boolean;
  approved: boolean;
  thumbnails?: { "500"?: string; large?: string; "250"?: string };
}

function publicImageUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    !(url.hostname === "coverartarchive.org" || url.hostname === "archive.org" || url.hostname.endsWith(".archive.org"))) {
    throw new Error("Cover Art Archive returned an unsupported image URL");
  }
  url.protocol = "https:";
  return url.href;
}

export async function findAlbumArtwork(artist: string, album: string, releaseGroupId?: string | null): Promise<string | null> {
  const groups = releaseGroupId ? [releaseGroupId] : await albumReleaseGroups(artist, album);
  for (const id of groups) {
    if (!/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) throw new Error("Invalid MusicBrainz release group ID");
    let data: { images: ArchiveImage[] };
    try {
      data = await httpJson(`https://coverartarchive.org/release-group/${id}`, { timeoutMs: 15_000, retries: 0 });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) continue;
      throw err;
    }
    const front = data.images?.find((image) => image.front && image.approved);
    const thumbnail = front?.thumbnails?.["500"] ?? front?.thumbnails?.large ?? front?.thumbnails?.["250"];
    if (thumbnail) return publicImageUrl(thumbnail);
  }
  return null;
}
