export const dynamic = "force-dynamic";
export async function GET() {
  return new Response(null, { status: 303, headers: { location: "/app/music", "cache-control": "no-store" } });
}
