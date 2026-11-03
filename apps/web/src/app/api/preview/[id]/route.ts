import { isUuid, serveFile } from "@/lib/files";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });
  return serveFile(req, `${id.toLowerCase()}.mp3`, "audio/mpeg");
}
