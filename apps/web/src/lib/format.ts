export function formatDuration(sec: number | null | undefined) {
  if (!sec || sec < 0) return "–:––";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatHours(sec: number) {
  const h = sec / 3600;
  if (h < 1) return `${Math.round(sec / 60)} min`;
  if (h < 100) return `${h.toFixed(1)} h`;
  return `${Math.round(h).toLocaleString("en-US")} h`;
}

export function formatBytes(bytes: number) {
  if (!bytes) return "0 GB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatCount(n: number) {
  return n.toLocaleString("en-US");
}

export function timeAgo(iso: string | Date | null | undefined) {
  if (!iso) return "never";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const youtubeMusicUrl = (videoId: string) => `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
