import { encrypt } from "@mint/core/crypto";
import { getDb } from "@mint/core/db";
import { getMatchingView, matchingSettings } from "@mint/core/matching-db";
import { openaiApiKeySchema } from "@mint/core/matching";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { analysisAdmin, analysisBody, analysisJson as json } from "@/lib/analysis-api";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await analysisAdmin();
  if (auth.error) return auth.error;
  try {
    return json({ controls: await getMatchingView() });
  } catch (error) {
    console.error("Matching settings failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Matching settings unavailable. Apply the latest database migration." }, 503);
  }
}

const change = z.object({
  enabled: z.boolean(),
  apiKey: openaiApiKeySchema.optional(),
  clearKey: z.boolean().optional(),
}).strict();

export async function POST(request: Request) {
  const auth = await analysisAdmin(request);
  if (auth.error) return auth.error;
  let input;
  try { input = change.safeParse(await analysisBody(request)); }
  catch { return json({ error: "Invalid JSON request" }, 400); }
  if (!input.success) {
    return json({ error: input.error.issues.some((issue) => issue.path[0] === "apiKey")
      ? "Enter an OpenAI API key beginning with sk-."
      : "Invalid matching controls" }, 400);
  }
  if (input.data.clearKey && input.data.apiKey) return json({ error: "Invalid matching controls" }, 400);
  try {
    if (!await rateLimit(`matching-admin:${auth.user.id}`, 20, 60)) {
      return json({ error: "Too many matching changes; wait one minute" }, 429);
    }
    const db = getDb();
    const [current] = await db.select({ openaiKeyEnc: matchingSettings.openaiKeyEnc })
      .from(matchingSettings).where(eq(matchingSettings.id, "global"));
    const openaiKeyEnc = input.data.clearKey ? null : input.data.apiKey ? encrypt(input.data.apiKey) : current?.openaiKeyEnc ?? null;
    if (input.data.enabled && !openaiKeyEnc) return json({ error: "Add an OpenAI API key before enabling song matching." }, 400);
    const controls = { enabled: input.data.enabled };
    await db.insert(matchingSettings)
      .values({ id: "global", controls, openaiKeyEnc, updatedBy: auth.user.id })
      .onConflictDoUpdate({
        target: matchingSettings.id,
        set: { controls, openaiKeyEnc, updatedBy: auth.user.id, updatedAt: new Date() },
      });
    return json({ controls: await getMatchingView() });
  } catch (error) {
    console.error("Matching settings update failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Matching settings change failed. Check database health." }, 503);
  }
}
