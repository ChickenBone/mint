import { z } from "zod";

export const accountRoleSchema = z.enum(["user", "admin"]);
export type AccountRole = z.infer<typeof accountRoleSchema>;

export const accountStatusSchema = z.enum(["pending", "active", "denied", "disabled"]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const accountPrincipalSchema = z.object({
  id: z.guid(),
  email: z.string(),
  name: z.string(),
  role: accountRoleSchema,
  status: accountStatusSchema,
});
export type AccountPrincipal = z.infer<typeof accountPrincipalSchema>;
