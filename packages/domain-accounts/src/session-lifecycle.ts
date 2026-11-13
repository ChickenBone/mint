import { createHash, randomBytes } from "node:crypto";
import { accountPrincipalSchema } from "@mint/contracts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Storage-only evidence: id is the SHA256 hex token hash, never the token. */
export interface StoredSessionEvidence {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  /** Passed through unchanged; absent metadata is not inferred by storage. */
  ip: string | null | undefined;
  /** Current optional chaining maps absent/null input to undefined. */
  userAgent: string | undefined;
}

export interface SessionLifecycleRepository {
  insertSession(session: StoredSessionEvidence): Promise<void>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
}

export interface SessionIssuanceInput {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface SessionIssuanceDependencies {
  now?: () => Date;
  generateToken?: () => string;
}

/** The result is secret HTTP-composition material, not a public principal DTO. */
export async function issueBrowserSession(
  input: SessionIssuanceInput,
  repository: SessionLifecycleRepository,
  dependencies: SessionIssuanceDependencies = {},
): Promise<{ token: string; expiresAt: Date }> {
  const userId = accountPrincipalSchema.shape.id.parse(input.userId);
  const token = dependencies.generateToken
    ? dependencies.generateToken()
    : randomBytes(32).toString("base64url");
  const createdAt = new Date((dependencies.now ?? (() => new Date()))().getTime());
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
  if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(expiresAt.getTime())) {
    throw new RangeError("Invalid session clock");
  }

  await repository.insertSession({
    id: createHash("sha256").update(token).digest("hex"),
    userId,
    expiresAt: new Date(expiresAt),
    createdAt,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 300),
  });
  return { token, expiresAt };
}

export async function revokeBrowserSession(
  token: string | null | undefined,
  repository: SessionLifecycleRepository,
): Promise<void> {
  if (!token) return;
  await repository.deleteByTokenHash(createHash("sha256").update(token).digest("hex"));
}
