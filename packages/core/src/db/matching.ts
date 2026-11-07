import { decrypt } from "../crypto";
import { eq } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { DEFAULT_MATCHING_CONTROLS, matchingControlsSchema, openAiKeyHint, type MatchingControls, type MatchingView } from "../matching";
import { getDb, type Db } from "./index";
import { users } from "./schema";

export const matchingSettings = pgTable("matching_settings", {
  id: text("id").primaryKey().default("global"),
  controls: jsonb("controls").$type<MatchingControls>().notNull(),
  openaiKeyEnc: text("openai_key_enc"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

function readKey(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    const key = decrypt(payload);
    return key.startsWith("sk-") ? key : null;
  } catch {
    return null;
  }
}

export async function getMatchingDecision(db: Db = getDb()): Promise<{ enabled: boolean; apiKey: string | null }> {
  const [settings] = await db.select({ controls: matchingSettings.controls, openaiKeyEnc: matchingSettings.openaiKeyEnc })
    .from(matchingSettings).where(eq(matchingSettings.id, "global"));
  const controls = matchingControlsSchema.safeParse(settings?.controls);
  const apiKey = readKey(settings?.openaiKeyEnc);
  return { enabled: controls.success && controls.data.enabled && apiKey !== null, apiKey };
}

export async function getMatchingView(db: Db = getDb()): Promise<MatchingView> {
  const [settings] = await db.select({ controls: matchingSettings.controls, openaiKeyEnc: matchingSettings.openaiKeyEnc })
    .from(matchingSettings).where(eq(matchingSettings.id, "global"));
  const controls = matchingControlsSchema.safeParse(settings?.controls);
  const apiKey = readKey(settings?.openaiKeyEnc);
  return {
    enabled: controls.success ? controls.data.enabled : DEFAULT_MATCHING_CONTROLS.enabled,
    keyConfigured: apiKey !== null,
    keyHint: apiKey ? openAiKeyHint(apiKey) : null,
  };
}
