import {
  accountPrincipalSchema, BROWSER_SESSION_COOKIE_NAME, browserSessionTokenSchema,
  decideAccessRequestInputSchema, GATEWAY_TOKEN_HEADER_NAME, gatewayTokenSchema,
  libraryListInputSchema, libraryFilePageSchema,
  setMemberStatusInputSchema, type SetMemberStatusInput,
  type AccountPrincipal, type DecideAccessRequestInput,
  type LibraryFilePage, type LibraryListInput,
  adminAccountListInputSchema, adminAccountPageSchema, setMemberRoleInputSchema,
  type AdminAccountListInput, type AdminAccountPage, type SetMemberRoleInput,
} from "@mint/contracts";
import { createTRPCUntypedClient, httpLink } from "@trpc/client";

export type MintSdkErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_INPUT"
  | "INCOMPATIBLE_RESPONSE"
  | "TRANSPORT_ERROR"
  | "RPC_ERROR";

export class MintSdkError extends Error {
  constructor(readonly code: MintSdkErrorCode) {
    const messages: Record<MintSdkErrorCode, string> = {
      INVALID_OPTIONS: "Invalid Mint SDK connection options.",
      INVALID_INPUT: "Invalid Mint SDK request input.",
      INCOMPATIBLE_RESPONSE: "The server response is incompatible with this SDK.",
      TRANSPORT_ERROR: "The Mint API could not be reached.",
      RPC_ERROR: "The Mint API request failed.",
    };
    super(messages[code]);
    this.name = "MintSdkError";
  }
}

export interface MintSdkOptions {
  /** Explicit trusted tRPC endpoint, including /trpc; no environment default. */
  url: string;
  /** Trusted server-only service secret. Never put this value in a browser bundle. */
  gatewayToken: string;
  /** Only this opaque browser-session token is forwarded, not a cookie jar. */
  sessionToken?: string;
  fetch?: typeof globalThis.fetch;
}

export interface MintSdk {
  library: {
    listFiles(input?: LibraryListInput, options?: { signal?: AbortSignal }): Promise<LibraryFilePage>;
  };
  accounts: {
    session(options?: { signal?: AbortSignal }): Promise<AccountPrincipal | null>;
    decideAccessRequest(input: DecideAccessRequestInput, options?: { signal?: AbortSignal }): Promise<void>;
    setMemberStatus(input: SetMemberStatusInput, options?: { signal?: AbortSignal }): Promise<void>;
    listAccounts(input?: AdminAccountListInput, options?: { signal?: AbortSignal }): Promise<AdminAccountPage>;
    setMemberRole(input: SetMemberRoleInput, options?: { signal?: AbortSignal }): Promise<void>;
  };
}

export function createMintSdk(options: MintSdkOptions): MintSdk {
  if (!gatewayTokenSchema.safeParse(options?.gatewayToken).success) {
    throw new MintSdkError("INVALID_OPTIONS");
  }
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new MintSdkError("INVALID_OPTIONS");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) {
    throw new MintSdkError("INVALID_OPTIONS");
  }
  if (options.sessionToken !== undefined && !browserSessionTokenSchema.safeParse(options.sessionToken).success) {
    throw new MintSdkError("INVALID_OPTIONS");
  }
  const token = options.sessionToken;
  const gatewayToken = options.gatewayToken;
  const transport = options.fetch ?? globalThis.fetch;
  const client = createTRPCUntypedClient({
    links: [httpLink({
      url: url.href.replace(/\/$/, ""),
      headers: () => ({
        [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken,
        ...(token === undefined ? {} : { cookie: `${BROWSER_SESSION_COOKIE_NAME}=${token}` }),
      }),
      fetch: async (input, init) => {
        try {
          const response = await transport(input, {
            ...init, credentials: "omit", cache: "no-store", redirect: "error",
          });
          if (!response.ok) throw new MintSdkError("RPC_ERROR");
          return response;
        } catch (error) {
          init?.signal?.throwIfAborted();
          if (error instanceof MintSdkError) throw error;
          throw new MintSdkError("TRANSPORT_ERROR");
        }
      },
    })],
  });
  const output = accountPrincipalSchema.nullable();
  return {
    library: {
      async listFiles(input = {}, { signal } = {}) {
        const parsed = libraryListInputSchema.safeParse(input);
        if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
        let value: unknown;
        try {
          value = await client.query("library.listFiles", parsed.data, { signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
            throw error.cause;
          }
          throw new MintSdkError("RPC_ERROR");
        }
        const page = libraryFilePageSchema.safeParse(value);
        if (!page.success || page.data.items.length > (parsed.data.limit ?? 50)) {
          throw new MintSdkError("INCOMPATIBLE_RESPONSE");
        }
        return page.data;
      },
    },
    accounts: {
      async listAccounts(input = {}, { signal } = {}) {
        const parsed = adminAccountListInputSchema.safeParse(input);
        if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
        let value: unknown;
        try {
          value = await client.query("accounts.listAccounts", parsed.data, { signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
            throw error.cause;
          }
          throw new MintSdkError("RPC_ERROR");
        }
        const page = adminAccountPageSchema.safeParse(value);
        if (!page.success || page.data.items.length > (parsed.data.limit ?? 50)) {
          throw new MintSdkError("INCOMPATIBLE_RESPONSE");
        }
        return page.data;
      },
      async setMemberRole(input, { signal } = {}) {
        const parsed = setMemberRoleInputSchema.safeParse(input);
        if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
        let value: unknown;
        try {
          value = await client.mutation("accounts.setMemberRole", parsed.data, { signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
            throw error.cause;
          }
          throw new MintSdkError("RPC_ERROR");
        }
        if (value !== null) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
      },
      async setMemberStatus(input, { signal } = {}) {
        const parsed = setMemberStatusInputSchema.safeParse(input);
        if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
        let value: unknown;
        try {
          value = await client.mutation("accounts.setMemberStatus", parsed.data, { signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
            throw error.cause;
          }
          throw new MintSdkError("RPC_ERROR");
        }
        if (value !== null) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
      },
      async session({ signal } = {}) {
        let value: unknown;
        try {
          value = await client.query("accounts.session", undefined, { signal });
        } catch (error) {
          signal?.throwIfAborted();
          // tRPC wraps fetch errors; retain only our sanitized category.
          if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
            throw error.cause;
          }
          throw new MintSdkError("RPC_ERROR");
        }
        const parsed = output.safeParse(value);
        if (!parsed.success) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
        return parsed.data;
      },
      async decideAccessRequest(input, { signal } = {}) {
        const parsed = decideAccessRequestInputSchema.safeParse(input);
        if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
        let value: unknown;
        try {
          value = await client.mutation("accounts.decideAccessRequest", parsed.data, { signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
            throw error.cause;
          }
          throw new MintSdkError("RPC_ERROR");
        }
        if (value !== null) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
      },
    },
  };
}
