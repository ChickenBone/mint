import { z } from "zod";
import { accountPrincipalSchema } from "./accounts";

export const browserSignInInputSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
});
export type BrowserSignInInput = z.infer<typeof browserSignInInputSchema>;

export const accountAccessRequestInputSchema = z
  .object({
    name: z.string().trim().min(1, "Tell us your name.").max(80),
    email: z.email("Enter a valid email address.").max(200),
    password: z.string().min(10, "Use at least 10 characters.").max(200),
    confirm: z.string(),
    note: z.string().trim().max(500).optional(),
    website: z.string().max(0).optional(),
  })
  .refine((d) => d.password === d.confirm, { path: ["confirm"], message: "Passwords don't match." });
export type AccountAccessRequestInput = z.infer<typeof accountAccessRequestInputSchema>;

export const decideAccessRequestInputSchema = z.strictObject({
  userId: accountPrincipalSchema.shape.id,
  approve: z.boolean(),
});
export type DecideAccessRequestInput = z.infer<typeof decideAccessRequestInputSchema>;

export const setMemberStatusInputSchema = z.strictObject({
  userId: accountPrincipalSchema.shape.id,
  status: z.enum(["active", "disabled"]),
});
export type SetMemberStatusInput = z.infer<typeof setMemberStatusInputSchema>;
