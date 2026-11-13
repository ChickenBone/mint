import {
  accountPrincipalSchema, adminAccountListInputSchema, setMemberRoleInputSchema,
  type AccountPrincipal, type AdminAccountListInput, type AdminAccountPage, type SetMemberRoleInput,
} from "@mint/contracts";

export interface AdminAccountsRepository {
  listAccounts(input: AdminAccountListInput): Promise<AdminAccountPage>;
  setMemberRole(input: SetMemberRoleInput): Promise<void>;
}

export class AdminAccountsForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "AdminAccountsForbiddenError";
  }
}

export class AdminAccountsSelfRoleError extends Error {
  constructor() {
    super("You can't change your own role.");
    this.name = "AdminAccountsSelfRoleError";
  }
}

export class AdminAccountsInputError extends TypeError {
  constructor() {
    super("Invalid account management input.");
    this.name = "AdminAccountsInputError";
  }
}

function requireAdmin(actor: AccountPrincipal | null): AccountPrincipal {
  const parsed = accountPrincipalSchema.safeParse(actor);
  if (!parsed.success || parsed.data.status !== "active" || parsed.data.role !== "admin") {
    throw new AdminAccountsForbiddenError();
  }
  return parsed.data;
}

/** Actor must come from a fresh trusted persisted-session lookup, never HTTP input. */
export function createAdminAccountsService(repository: AdminAccountsRepository) {
  return {
    async listAccounts(input: AdminAccountListInput, actor: AccountPrincipal | null) {
      requireAdmin(actor);
      const parsed = adminAccountListInputSchema.safeParse(input);
      if (!parsed.success) throw new AdminAccountsInputError();
      return repository.listAccounts(parsed.data);
    },
    async setMemberRole(input: SetMemberRoleInput, actor: AccountPrincipal | null) {
      const admin = requireAdmin(actor);
      const parsed = setMemberRoleInputSchema.safeParse(input);
      if (!parsed.success) throw new AdminAccountsInputError();
      if (parsed.data.userId.toLowerCase() === admin.id.toLowerCase()) {
        throw new AdminAccountsSelfRoleError();
      }
      await repository.setMemberRole(parsed.data);
    },
  };
}
