import { z } from "zod";
import { accountPrincipalSchema, accountRoleSchema, accountStatusSchema } from "./accounts";

const cursor = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);

export const adminAccountListInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  status: z.enum(["pending", "active", "disabled", "denied", "members"]).optional(),
  search: z.string().max(200).refine((value) => !value.includes("\0")).optional(),
  cursor: cursor.optional(),
});
export type AdminAccountListInput = z.infer<typeof adminAccountListInputSchema>;

export const adminAccountSchema = z.strictObject({
  id: accountPrincipalSchema.shape.id,
  email: z.string(),
  name: z.string(),
  role: accountRoleSchema,
  status: accountStatusSchema,
  requestNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminAccount = z.infer<typeof adminAccountSchema>;

export const adminAccountPageSchema = z.strictObject({
  items: z.array(adminAccountSchema).max(100),
  nextCursor: cursor.nullable(),
}).refine((page) => page.nextCursor === null || page.items.length > 0);
export type AdminAccountPage = z.infer<typeof adminAccountPageSchema>;

export const setMemberRoleInputSchema = z.strictObject({
  userId: accountPrincipalSchema.shape.id,
  role: accountRoleSchema,
});
export type SetMemberRoleInput = z.infer<typeof setMemberRoleInputSchema>;
