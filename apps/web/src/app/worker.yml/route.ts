import { workerCompose } from "@/lib/worker-compose";

export const dynamic = "force-static";

export function GET() {
  return new Response(workerCompose(), {
    headers: { "content-type": "text/yaml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
