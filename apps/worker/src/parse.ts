export interface ParsedMeta {
  title: string;
  artist: string;
  album: string | null;
  year: number | null;
}

const NOISE =
  /\s*[([](?:official\s*(?:music\s*)?(?:video|audio|visuali[sz]er|lyric(?:s)?\s*video)|lyric(?:s)?(?:\s*video)?|audio|video|hd|4k|visuali[sz]er|explicit|clean|mv|m\/v)[)\]]\s*/gi;

function clean(s: string) {
  return s.replace(NOISE, " ").replace(/\s{2,}/g, " ").trim();
}

function cleanChannel(channel: string) {
  return channel
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s*(?:official)?\s*$/i, "")
    .trim();
}

/** Extracts track metadata from a YouTube / YouTube Music video. Auto-generated "Provided to YouTube" descriptions are authoritative. */
export function parseYoutubeMeta(input: { title: string; channelTitle: string; description?: string | null }): ParsedMeta {
  const desc = input.description ?? "";
  if (/Provided to YouTube by/i.test(desc)) {
    const lines = desc.split(/\r?\n/).map((l) => l.trim());
    const dotIdx = lines.findIndex((l) => l.includes(" · "));
    if (dotIdx !== -1) {
      const [title, ...artists] = lines[dotIdx]!.split(" · ").map((s) => s.trim());
      const album = lines.slice(dotIdx + 1).find((l) => l.length > 0) ?? null;
      const released = desc.match(/Released on:\s*(\d{4})/i) ?? desc.match(/℗\s*(\d{4})/);
      if (title && artists.length) {
        return {
          title,
          artist: artists.join(", "),
          album: album && !album.startsWith("℗") ? album : null,
          year: released ? Number(released[1]) : null,
        };
      }
    }
  }

  const channel = input.channelTitle ?? "";
  if (/\s-\sTopic$/i.test(channel)) {
    return { title: clean(input.title), artist: cleanChannel(channel), album: null, year: null };
  }

  const title = clean(input.title);
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) return { artist: dash[1]!.trim(), title: dash[2]!.trim(), album: null, year: null };

  return { title, artist: cleanChannel(channel) || "Unknown Artist", album: null, year: null };
}

/** ISO-8601 duration (PT3M21S) to seconds. */
export function parseIsoDuration(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return (d ?? 0) * 86400 + (h ?? 0) * 3600 + (mi ?? 0) * 60 + (s ?? 0);
}

/** Filesystem-safe path segment (cross-platform, Plex friendly). */
export function safeSegment(s: string, max = 120): string {
  const out = s
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "_")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, max);
  return out || "_";
}
