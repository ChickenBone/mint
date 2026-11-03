import { isUuid, serveFile } from "@/lib/files";
import { artUrl } from "@/lib/media";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });
  if (process.env.NEXT_PUBLIC_MEDIA_URL) return Response.redirect(artUrl(id.toLowerCase()), 308);
  return serveFile(req, `art/${id.toLowerCase()}.jpg`, "image/jpeg");
}
