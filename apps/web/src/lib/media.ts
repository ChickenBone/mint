/**
 * Preview and cover-art URLs. On Vercel they point straight at the home-server hub
 * (NEXT_PUBLIC_MEDIA_URL); when self-hosted they fall back to the same-origin API routes.
 */
const base = (process.env.NEXT_PUBLIC_MEDIA_URL ?? "").replace(/\/$/, "");

export const previewUrl = (id: string) => (base ? `${base}/media/preview/${id}.mp3` : `/api/preview/${id}`);
export const artUrl = (id: string) => (base ? `${base}/media/art/${id}.jpg` : `/api/art/${id}`);
