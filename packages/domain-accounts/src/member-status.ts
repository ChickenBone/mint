import { accountPrincipalSchema, type AccountPrincipal } from "@mint/contracts";

export type MemberStatus = "active" | "disabled";

export interface MemberStatusInput {
  userId: string;
  status: MemberStatus;
}

export interface MemberStatusRepository {
  setMemberStatus(input: MemberStatusInput): Promise<void>;
}

export class MemberStatusForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "MemberStatusForbiddenError";
  }
}

export class MemberStatusSelfChangeError extends Error {
  constructor() {
    super("You can't disable your own account.");
    this.name = "MemberStatusSelfChangeError";
  }
}

const invalidInput = () => new TypeError("Invalid member status change");

/**
 * The actor must come from a fresh persisted-session lookup in trusted request composition.
 * Validating this DTO is not proof of identity. Never expose an actor DTO as HTTP input.
 */
export function createMemberStatusUpdater(repository: MemberStatusRepository) {
  return async function setMemberStatus(
    input: MemberStatusInput,
    actor: AccountPrincipal | null,
  ): Promise<void> {
    const parsedActor = accountPrincipalSchema.safeParse(actor);
    if (!parsedActor.success || parsedActor.data.status !== "active" || parsedActor.data.role !== "admin") {
      throw new MemberStatusForbiddenError();
    }

    if (typeof input !== "object" || input === null) throw invalidInput();
    const parsedUserId = accountPrincipalSchema.shape.id.safeParse(input.userId);
    if (!parsedUserId.success || (input.status !== "active" && input.status !== "disabled")) {
      throw invalidInput();
    }
    if (parsedUserId.data === parsedActor.data.id) throw new MemberStatusSelfChangeError();

    await repository.setMemberStatus({ userId: parsedUserId.data, status: input.status });
  };
}
