ALTER TABLE "matching_settings" ADD COLUMN IF NOT EXISTS "openai_key_enc" text;

UPDATE "matching_settings"
SET "controls" = jsonb_set("controls", '{enabled}', 'false'::jsonb)
WHERE "openai_key_enc" IS NULL;
