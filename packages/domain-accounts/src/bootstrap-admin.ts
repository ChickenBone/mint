import type { AccountAuthenticationRepository } from "./authenticate-account";

export interface AdminBootstrapInput {
  readonly email: string;
  readonly name: string;
  readonly password: string | null | undefined;
}

export interface BootstrapAdminAccount {
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly role: "admin";
  readonly status: "active";
  readonly approvedAt: Date;
}

export interface AdminBootstrapRepository extends
  Pick<AccountAuthenticationRepository, "findByLowercaseEmail"> {
  /** Atomically inserts on an absent case-insensitive email, without updating conflicts. */
  insertAdminIfAbsent(account: BootstrapAdminAccount): Promise<boolean>;
}

export interface AdminBootstrapDependencies {
  hash(password: string): Promise<string>;
  now(): Date;
}

export type AdminBootstrapResult = { status: "created" | "existing" | "missing-password" };

export async function bootstrapAdmin(
  input: AdminBootstrapInput,
  repository: AdminBootstrapRepository,
  dependencies: AdminBootstrapDependencies,
): Promise<AdminBootstrapResult> {
  if (!input.password) return { status: "missing-password" };
  if (await repository.findByLowercaseEmail(input.email.toLowerCase())) {
    return { status: "existing" };
  }

  const passwordHash = await dependencies.hash(input.password);
  const approvedAt = new Date(dependencies.now().getTime());
  if (!Number.isFinite(approvedAt.getTime())) {
    throw new RangeError("Invalid admin bootstrap clock");
  }
  const created = await repository.insertAdminIfAbsent({
    email: input.email,
    name: input.name,
    passwordHash,
    role: "admin",
    status: "active",
    approvedAt,
  });
  return { status: created ? "created" : "existing" };
}
