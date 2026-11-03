import { isUuid, serveFile } from "@/lib/files";
import { previewUrl } from "@/lib/media";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });
  if (process.env.NEXT_PUBLIC_MEDIA_URL) return Response.redirect(previewUrl(id.toLowerCase()), 308);
  return serveFile(req, `${id.toLowerCase()}.mp3`, "audio/mpeg");
}
