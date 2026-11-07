import { albumReleaseGroups } from "./musicbrainz";
import { readPublicMetadata } from "./public-metadata";
import { z } from "zod";
import type { PublicReadCache } from "@mint/core/public-cache";

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

const archiveSchema = z.object({ images: z.array(z.object({
  front: z.boolean(), approved: z.boolean(),
  thumbnails: z.object({ "500": z.string().max(2048).optional(), large: z.string().max(2048).optional(),
    "250": z.string().max(2048).optional() }).optional(),
})).max(100) });
export async function findAlbumArtwork(artist: string, album: string, releaseGroupId?: string | null,
  cache?: PublicReadCache | null): Promise<string | null> {
  const groups = releaseGroupId ? [releaseGroupId] : await albumReleaseGroups(artist, album, cache);
  for (const id of groups) {
    if (!/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) throw new Error("Invalid MusicBrainz release group ID");
    const data = await readPublicMetadata(`https://coverartarchive.org/release-group/${id}`, {
      provider: "CoverArtArchive", cache, notFound: () => null,
      validate: (value): { images: ArchiveImage[] } | null => {
        if (value === null) return null;
        const data = archiveSchema.parse(value);
        for (const image of data.images) for (const url of Object.values(image.thumbnails ?? {})) publicImageUrl(url);
        return data;
      },
      negative: (value) => !value || !value.images.some((image) => image.front && image.approved &&
        !!(image.thumbnails?.["500"] ?? image.thumbnails?.large ?? image.thumbnails?.["250"])),
    });
    if (!data) continue;
    const front = data.images?.find((image) => image.front && image.approved);
    const thumbnail = front?.thumbnails?.["500"] ?? front?.thumbnails?.large ?? front?.thumbnails?.["250"];
    if (thumbnail) return publicImageUrl(thumbnail);
  }
  return null;
}
