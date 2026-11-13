import { accountPrincipalSchema, type AccountPrincipal } from "@mint/contracts";

export type PendingAccessDecision =
  | { status: "active"; approvedAt: Date; approvedBy: string }
  | { status: "denied" };

export interface AccessRequestDecisionRepository {
  decidePendingAccess(input: { userId: string; decision: PendingAccessDecision }): Promise<void>;
  countPending(): Promise<number>;
}

export interface AccessRequestDecisionDependencies {
  repository: AccessRequestDecisionRepository;
  notify(notification: { pending: number }): Promise<void>;
  now(): Date;
}

export interface DecideAccessRequestInput {
  userId: string;
  approve: boolean;
}

export class AccessRequestDecisionForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "AccessRequestDecisionForbiddenError";
  }
}

const invalidInput = () => new TypeError("Invalid access-request decision");

/**
 * The actor must come from a fresh persisted-session lookup in trusted request composition.
 * Validating this DTO is not proof of identity. Never expose an actor DTO as HTTP input.
 */
export function createAccessRequestDecider({
  repository,
  notify,
  now,
}: AccessRequestDecisionDependencies) {
  return async function decideAccessRequest(
    input: DecideAccessRequestInput,
    actor: AccountPrincipal | null,
  ): Promise<void> {
    const parsedActor = accountPrincipalSchema.safeParse(actor);
    if (!parsedActor.success || parsedActor.data.status !== "active" || parsedActor.data.role !== "admin") {
      throw new AccessRequestDecisionForbiddenError();
    }

    if (typeof input !== "object" || input === null) throw invalidInput();
    const parsedUserId = accountPrincipalSchema.shape.id.safeParse(input.userId);
    if (!parsedUserId.success || typeof input.approve !== "boolean") throw invalidInput();

    let decision: PendingAccessDecision;
    if (input.approve) {
      const current = now();
      if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
        throw new RangeError("Invalid approval time");
      }
      decision = {
        status: "active",
        approvedAt: new Date(current.getTime()),
        approvedBy: parsedActor.data.id,
      };
    } else {
      decision = { status: "denied" };
    }

    await repository.decidePendingAccess({ userId: parsedUserId.data, decision });
    const pending = await repository.countPending();
    await notify({ pending });
  };
}
