import { z } from "zod";

export const BROWSER_SESSION_COOKIE_NAME = "mint_session";
export const browserSessionTokenSchema = z.string().min(1).max(512)
  .refine((value) => !/[^A-Za-z0-9_-]/.test(value));
