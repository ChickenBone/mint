import { workerCompose } from "@/lib/worker-compose";

export const dynamic = "force-dynamic";

export function GET() {
  return new Response(workerCompose(), {
    headers: { "content-type": "text/yaml; charset=utf-8", "cache-control": "no-store" },
  });
}
