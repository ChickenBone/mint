import {
  browserSignInInputSchema, browserSignInResultSchema,
  accountAccessRequestInputSchema, accountAccessRequestResultSchema,
  TRUSTED_CLIENT_IP_HEADER, trustedClientIpSchema,
  type BrowserSignInInput, type BrowserSignInResult,
  type AccountAccessRequestInput, type AccountAccessRequestResult,
} from "@mint/contracts";
import {
  accountPrincipalSchema, BROWSER_SESSION_COOKIE_NAME, browserSessionTokenSchema,
  decideAccessRequestInputSchema, GATEWAY_TOKEN_HEADER_NAME, gatewayTokenSchema,
  libraryListInputSchema, libraryFilePageSchema,
  listeningHistoryDeleteInputSchema, listeningHistoryListInputSchema,
  listeningHistoryPrivateSessionInputSchema, listeningHistoryRecordInputSchema,
  listeningHistoryRecordResultSchema, listeningHistoryPrivateSessionSchema, listeningHistoryPageSchema,
  setMemberStatusInputSchema, type SetMemberStatusInput,
  type AccountPrincipal, type DecideAccessRequestInput,
  type LibraryFilePage, type LibraryListInput,
  adminAccountListInputSchema, adminAccountPageSchema, setMemberRoleInputSchema,
  pendingAccessRequestCountSchema,
  playbackQueueEditInputSchema, playbackQueueEditRequestSchema,
  playbackQueueOpenInputSchema, playbackQueuePageInputSchema,
  playbackQueuePageRequestSchema, playbackQueuePageSchema,
  type AdminAccountListInput, type AdminAccountPage, type SetMemberRoleInput,
  type ListeningHistoryDeleteInput, type ListeningHistoryListInput,
  type ListeningHistoryPage, type ListeningHistoryPrivateSessionInput,
  type ListeningHistoryRecordInput,
  type PlaybackQueueEditInput, type PlaybackQueueOpenInput, type PlaybackQueuePage,
  type PlaybackQueuePageInput,
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
  /** Server-only ingress-derived IP; never accept this option from browser input. */
  trustedClientIp?: string;
  /** Optional bounded browser metadata supplied by the trusted server gateway. */
  userAgent?: string;
  fetch?: typeof globalThis.fetch;
}

export interface MintSdk {
  library: {
    listFiles(input?: LibraryListInput, options?: { signal?: AbortSignal }): Promise<LibraryFilePage>;
  };
  accounts: {
    signIn(input: BrowserSignInInput, options?: { signal?: AbortSignal }): Promise<BrowserSignInResult>;
    requestAccess(input: AccountAccessRequestInput, options?: { signal?: AbortSignal }): Promise<AccountAccessRequestResult>;
    signOut(options?: { signal?: AbortSignal }): Promise<void>;
    session(options?: { signal?: AbortSignal }): Promise<AccountPrincipal | null>;
    pendingAccessRequestCount(options?: { signal?: AbortSignal }): Promise<number>;
    decideAccessRequest(input: DecideAccessRequestInput, options?: { signal?: AbortSignal }): Promise<void>;
    setMemberStatus(input: SetMemberStatusInput, options?: { signal?: AbortSignal }): Promise<void>;
    listAccounts(input?: AdminAccountListInput, options?: { signal?: AbortSignal }): Promise<AdminAccountPage>;
    setMemberRole(input: SetMemberRoleInput, options?: { signal?: AbortSignal }): Promise<void>;
  };
  playback: {
    queue: {
      open(input: PlaybackQueueOpenInput, options?: { signal?: AbortSignal }): Promise<PlaybackQueuePage>;
      page(queueId: string, input: PlaybackQueuePageInput, options?: { signal?: AbortSignal }): Promise<PlaybackQueuePage>;
      edit(queueId: string, input: PlaybackQueueEditInput, options?: { signal?: AbortSignal }): Promise<PlaybackQueuePage>;
    };
    history: {
      list(input?: ListeningHistoryListInput, options?: { signal?: AbortSignal }): Promise<ListeningHistoryPage>;
      record(input: ListeningHistoryRecordInput, options?: { signal?: AbortSignal }): Promise<{ recorded: boolean }>;
      delete(input?: ListeningHistoryDeleteInput, options?: { signal?: AbortSignal }): Promise<void>;
      privateSession(options?: { signal?: AbortSignal }): Promise<boolean>;
      setPrivateSession(input: ListeningHistoryPrivateSessionInput, options?: { signal?: AbortSignal }): Promise<void>;
    };
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
  if (options.userAgent !== undefined && (typeof options.userAgent !== "string"
    || options.userAgent.length > 300 || /[\r\n\0]/.test(options.userAgent))) {
    throw new MintSdkError("INVALID_OPTIONS");
  }
  const ip = options.trustedClientIp === undefined ? undefined
    : trustedClientIpSchema.safeParse(options.trustedClientIp);
  if (ip && !ip.success) throw new MintSdkError("INVALID_OPTIONS");
  const gatewayToken = options.gatewayToken;
  const transport = options.fetch ?? globalThis.fetch;
  const client = createTRPCUntypedClient({
    links: [httpLink({
      url: url.href.replace(/\/$/, ""),
      headers: () => ({
        [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken,
        ...(ip?.success ? { [TRUSTED_CLIENT_IP_HEADER]: ip.data } : {}),
        ...(options.userAgent === undefined ? {} : { "user-agent": options.userAgent }),
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
      async pendingAccessRequestCount({ signal } = {}) {
        let value: unknown;
        try {
          value = await client.query("accounts.pendingAccessRequestCount", undefined, { signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
            throw error.cause;
          }
          throw new MintSdkError("RPC_ERROR");
        }
        const count = pendingAccessRequestCountSchema.safeParse(value);
        if (!count.success) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
        return count.data;
      },
      async signIn(input, { signal } = {}) {
        const parsed = browserSignInInputSchema.safeParse(input);
        if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
        let value: unknown;
        try {
          value = await client.mutation("accounts.signIn", parsed.data, { signal });
        } catch {
          signal?.throwIfAborted();
          throw new MintSdkError("RPC_ERROR");
        }
        const result = browserSignInResultSchema.safeParse(value);
        if (!result.success) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
        return result.data;
      },
      async requestAccess(input, { signal } = {}) {
        const parsed = accountAccessRequestInputSchema.safeParse(input);
        if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
        let value: unknown;
        try {
          value = await client.mutation("accounts.requestAccess", parsed.data, { signal });
        } catch {
          signal?.throwIfAborted();
          throw new MintSdkError("RPC_ERROR");
        }
        const result = accountAccessRequestResultSchema.safeParse(value);
        if (!result.success) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
        return result.data;
      },
      async signOut({ signal } = {}) {
        let value: unknown;
        try {
          value = await client.mutation("accounts.signOut", undefined, { signal });
        } catch {
          signal?.throwIfAborted();
          throw new MintSdkError("RPC_ERROR");
        }
        if (value !== null) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
      },
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
    playback: {
      queue: {
        async open(input, { signal } = {}) {
          const parsed = playbackQueueOpenInputSchema.safeParse(input);
          if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
          let value: unknown;
          try {
            value = await client.mutation("playback.queue.open", parsed.data, { signal });
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
              throw error.cause;
            }
            throw new MintSdkError("RPC_ERROR");
          }
          const page = playbackQueuePageSchema.safeParse(value);
          if (!page.success) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
          return page.data;
        },
        async page(queueId, input, { signal } = {}) {
          const parsedId = playbackQueuePageRequestSchema.shape.queueId.safeParse(queueId);
          const parsedInput = playbackQueuePageInputSchema.safeParse(input);
          if (!parsedId.success || !parsedInput.success) throw new MintSdkError("INVALID_INPUT");
          const request = playbackQueuePageRequestSchema.safeParse({ queueId: parsedId.data, ...parsedInput.data });
          if (!request.success) throw new MintSdkError("INVALID_INPUT");
          let value: unknown;
          try {
            value = await client.query("playback.queue.page", request.data, { signal });
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
              throw error.cause;
            }
            throw new MintSdkError("RPC_ERROR");
          }
          const page = playbackQueuePageSchema.safeParse(value);
          if (!page.success) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
          return page.data;
        },
        async edit(queueId, input, { signal } = {}) {
          const parsedId = playbackQueueEditRequestSchema.shape.queueId.safeParse(queueId);
          const parsedInput = playbackQueueEditInputSchema.safeParse(input);
          if (!parsedId.success || !parsedInput.success) throw new MintSdkError("INVALID_INPUT");
          const request = playbackQueueEditRequestSchema.safeParse({ queueId: parsedId.data, ...parsedInput.data });
          if (!request.success) throw new MintSdkError("INVALID_INPUT");
          let value: unknown;
          try {
            value = await client.mutation("playback.queue.edit", request.data, { signal });
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
              throw error.cause;
            }
            throw new MintSdkError("RPC_ERROR");
          }
          const page = playbackQueuePageSchema.safeParse(value);
          if (!page.success) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
          return page.data;
        },
      },
      history: {
        async list(input = {}, { signal } = {}) {
          const parsed = listeningHistoryListInputSchema.safeParse(input);
          if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
          let value: unknown;
          try {
            value = await client.query("playback.history.list", parsed.data, { signal });
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
              throw error.cause;
            }
            throw new MintSdkError("RPC_ERROR");
          }
          const page = listeningHistoryPageSchema.safeParse(value);
          if (!page.success || page.data.entries.length > 101) {
            throw new MintSdkError("INCOMPATIBLE_RESPONSE");
          }
          return page.data;
        },
        async record(input, { signal } = {}) {
          const parsed = listeningHistoryRecordInputSchema.safeParse(input);
          if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
          let value: unknown;
          try {
            value = await client.mutation("playback.history.record", parsed.data, { signal });
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
              throw error.cause;
            }
            throw new MintSdkError("RPC_ERROR");
          }
          const result = listeningHistoryRecordResultSchema.safeParse(value);
          if (!result.success) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
          return result.data;
        },
        async delete(input = {}, { signal } = {}) {
          const parsed = listeningHistoryDeleteInputSchema.safeParse(input);
          if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
          let value: unknown;
          try {
            value = await client.mutation("playback.history.delete", parsed.data, { signal });
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
              throw error.cause;
            }
            throw new MintSdkError("RPC_ERROR");
          }
          if (value !== null) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
        },
        async privateSession({ signal } = {}) {
          let value: unknown;
          try {
            value = await client.query("playback.history.privateSession", undefined, { signal });
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && "cause" in error && error.cause instanceof MintSdkError) {
              throw error.cause;
            }
            throw new MintSdkError("RPC_ERROR");
          }
          const parsed = listeningHistoryPrivateSessionSchema.safeParse(value);
          if (!parsed.success) throw new MintSdkError("INCOMPATIBLE_RESPONSE");
          return parsed.data;
        },
        async setPrivateSession(input, { signal } = {}) {
          const parsed = listeningHistoryPrivateSessionInputSchema.safeParse(input);
          if (!parsed.success) throw new MintSdkError("INVALID_INPUT");
          let value: unknown;
          try {
            value = await client.mutation("playback.history.setPrivateSession", parsed.data, { signal });
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
    },
  };
}
