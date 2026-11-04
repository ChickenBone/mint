export const dynamic = "force-dynamic";
export async function GET() {
  return new Response(null, { status: 303, headers: { location: "/app/library", "cache-control": "no-store" } });
}
