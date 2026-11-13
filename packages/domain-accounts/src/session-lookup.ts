import { createHash } from "node:crypto";
import type { AccountPrincipal } from "@mint/contracts";

export interface SessionEvidence {
  expiresAt: Date;
  principal: AccountPrincipal;
}

export interface SessionLookupRepository {
  findByTokenHash(tokenHash: string): Promise<SessionEvidence | null>;
}

export async function lookupBrowserSession(
  token: string | null | undefined,
  repository: SessionLookupRepository,
  now: () => Date = () => new Date(),
): Promise<AccountPrincipal | null> {
  if (!token || token.startsWith("mn1.")) return null;

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const session = await repository.findByTokenHash(tokenHash);
  if (!session || !(session.expiresAt.getTime() > now().getTime()) || session.principal.status !== "active") {
    return null;
  }

  const { id, email, name, role, status } = session.principal;
  return { id, email, name, role, status };
}
