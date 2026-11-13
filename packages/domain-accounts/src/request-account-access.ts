import { accountAccessRequestInputSchema, type AccountAccessRequestInput } from "@mint/contracts";
import type {
  AccountAuthenticationAdmission,
  AccountAuthenticationRepository,
} from "./authenticate-account";

export interface PendingAccount {
  readonly name: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly requestNote: string | null;
}

export interface AccountAccessRequestRepository extends
  Pick<AccountAuthenticationRepository, "findByLowercaseEmail"> {
  /** Inserts a pending user only when its case-insensitive email is absent. */
  insertPendingIfAbsent(account: PendingAccount): Promise<boolean>;
  countPending(): Promise<number>;
}

export interface AccountAccessRequestDependencies {
  repository: AccountAccessRequestRepository;
  admission: AccountAuthenticationAdmission;
  hash(password: string): Promise<string>;
  notify(notification: { pending: number }): Promise<void>;
}

export type AccountAccessRequestResult =
  | { ok: true }
  | { error: string }
  | { fieldErrors: Record<string, string> };

export function createAccountAccessRequester({
  repository,
  admission,
  hash,
  notify,
}: AccountAccessRequestDependencies) {
  return async function requestAccountAccess(
    input: AccountAccessRequestInput,
    ip: string,
  ): Promise<AccountAccessRequestResult> {
    const parsed = accountAccessRequestInputSchema.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[String(issue.path[0])] ??= issue.message;
      }
      return { fieldErrors };
    }

    if (!(await admission.allow(`request:ip:${ip}`, 5, 3600))) {
      return { error: "Too many requests from your network. Try again in an hour." };
    }

    const { name, email, password, note } = parsed.data;
    if (await repository.findByLowercaseEmail(email.toLowerCase())) return { ok: true };

    const passwordHash = await hash(password);
    if (await repository.insertPendingIfAbsent({
      name, email, passwordHash, requestNote: note || null,
    })) {
      const pending = await repository.countPending();
      await notify({ pending });
    }
    return { ok: true };
  };
}
