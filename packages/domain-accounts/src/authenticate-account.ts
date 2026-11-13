import type { AccountPrincipal } from "@mint/contracts";

export interface AuthenticationAccount extends AccountPrincipal {
  passwordHash: string;
}

export interface AccountAuthenticationRepository {
  findByLowercaseEmail(email: string): Promise<AuthenticationAccount | null>;
}

export interface AccountAuthenticationPasswords {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface AccountAuthenticationAdmission {
  allow(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

export interface AccountAuthenticationLogger {
  error(message: string, errorName: string): void;
}

export interface AccountAuthenticationDependencies {
  repository: AccountAuthenticationRepository;
  passwords: AccountAuthenticationPasswords;
  admission: AccountAuthenticationAdmission;
  logger: AccountAuthenticationLogger;
}

export type AccountAuthenticationResult =
  | { principal: AccountPrincipal }
  | { error: string; status: 401 | 403 | 429 | 503 };

export function createAccountAuthenticator({
  repository,
  passwords,
  admission,
  logger,
}: AccountAuthenticationDependencies) {
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = () => (dummyHash ??= passwords.hash("mint-timing-equaliser"));

  return async function authenticateAccount(
    email: string,
    password: string,
    ip: string,
  ): Promise<AccountAuthenticationResult> {
    if (!(await admission.allow(`login:ip:${ip}`, 20, 900))
      || !(await admission.allow(`login:email:${email.toLowerCase()}`, 8, 900))) {
      return { error: "Too many attempts. Wait 15 minutes and try again.", status: 429 };
    }

    const account = await repository.findByLowercaseEmail(email.toLowerCase());
    let valid: boolean;
    try {
      valid = await passwords.verify(account?.passwordHash ?? (await getDummyHash()), password);
    } catch (error) {
      logger.error("[auth] password verification failed", error instanceof Error ? error.name : "Unknown failure");
      return { error: "Sign-in is unavailable. Try again later.", status: 503 };
    }

    if (!account || !valid) {
      return { error: "That email and password don't match an account.", status: 401 };
    }
    if (account.status === "pending") {
      return {
        error: "Your request is still waiting for approval. You'll be able to sign in once an admin lets you in.",
        status: 403,
      };
    }
    if (account.status !== "active") {
      return { error: "This account can't sign in. Contact the admin.", status: 403 };
    }

    const { id, email: storedEmail, name, role, status } = account;
    return { principal: { id, email: storedEmail, name, role, status } };
  };
}
