import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import {
  accountAccessRequestInputSchema, accountAccessRequestResultSchema,
  browserSignInInputSchema, browserSignInResultSchema,
  TRUSTED_CLIENT_IP_HEADER, trustedClientIpSchema,
} from "@mint/contracts";
import {
  createAccountAuthenticator, createAccountAccessRequester,
  issueBrowserSession, revokeBrowserSession,
  type AccountsRepository, type AccountAuthenticationPasswords,
  type AccountAuthenticationAdmission,
} from "@mint/domain-accounts";
import {
  accountPrincipalSchema, BROWSER_SESSION_COOKIE_NAME, browserSessionTokenSchema,
  decideAccessRequestInputSchema, GATEWAY_TOKEN_HEADER_NAME, gatewayTokenSchema,
  libraryListInputSchema, libraryFilePageSchema,
  listeningHistoryDeleteInputSchema, listeningHistoryListInputSchema,
  listeningHistoryPrivateSessionInputSchema, listeningHistoryRecordInputSchema,
  listeningHistoryRecordResultSchema, listeningHistoryPageSchema,
  setMemberStatusInputSchema,
  adminAccountListInputSchema, adminAccountPageSchema, setMemberRoleInputSchema,
  pendingAccessRequestCountSchema,
  playbackQueueEditRequestSchema, playbackQueueOpenInputSchema, playbackQueuePageRequestSchema,
  playbackQueuePageSchema,
} from "@mint/contracts";
import {
  AccessRequestDecisionForbiddenError, createAccessRequestDecider, lookupBrowserSession,
  createMemberStatusUpdater, MemberStatusForbiddenError, MemberStatusSelfChangeError,
  type AccessRequestDecisionRepository, type SessionLookupRepository,
  type MemberStatusRepository,
  createAdminAccountsService, AdminAccountsForbiddenError, AdminAccountsSelfRoleError,
  AdminAccountsInputError, type AdminAccountsRepository,
} from "@mint/domain-accounts";
import {
  LIBRARY_MEDIA_READ_MAX_BYTES, LibraryMediaRangeError, LibraryPlaybackMediaError,
  LibraryRepositoryInputError, openLibraryPlaybackMedia, parseLibraryMediaByteRange,
  type LibraryRepository,
} from "@mint/domain-library";
import {
  ListeningHistoryInputError, ListeningHistoryMediaUnavailableError,
  PlaybackQueueError,
  type PlaybackQueueRepository,
  type ListeningHistoryRepository,
} from "@mint/domain-playback";
import { initTRPC, TRPCError } from "@trpc/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify, { type FastifyInstance } from "fastify";

export interface ApiErrorLogger {
  error(event: { name: string }): void;
}

export interface ApiServerDependencies {
  /** Explicit server-only service credential, never a user identity. */
  gatewayToken: string;
  publicAuth?: {
    trustedProxy: "gateway";
    repository: AccountsRepository;
    passwords: AccountAuthenticationPasswords;
    admission: AccountAuthenticationAdmission;
  };
  sessions: SessionLookupRepository;
  decisions: AccessRequestDecisionRepository;
  memberStatuses?: MemberStatusRepository;
  adminAccounts?: AdminAccountsRepository;
  library?: Pick<LibraryRepository, "listFiles">;
  libraryMedia?: Pick<LibraryRepository, "getPlaybackTarget" | "recordVerification">;
  playbackHistory?: ListeningHistoryRepository;
  playbackQueues?: PlaybackQueueRepository;
  notifyAccessRequests(notification: { pending: number }): Promise<void>;
  errors: ApiErrorLogger;
  now?: () => Date;
}

interface ApiContext {
  sessionToken: string | null;
  clientIp: string | null;
  userAgent: string | undefined;
}

const trpc = initTRPC.context<ApiContext>().create({
  errorFormatter({ shape }) {
    return {
      message: shape.data.code === "INTERNAL_SERVER_ERROR" ? "Internal server error" : shape.message,
      code: shape.code,
      data: { code: shape.data.code, httpStatus: shape.data.httpStatus },
    };
  },
});

function createRouter(dependencies: ApiServerDependencies) {
  const auth = dependencies.publicAuth;
  const authenticate = auth && createAccountAuthenticator({
    repository: auth.repository, passwords: auth.passwords, admission: auth.admission,
    logger: { error: () => dependencies.errors.error({ name: "PasswordVerificationError" }) },
  });
  const requestAccess = auth && createAccountAccessRequester({
    repository: auth.repository, admission: auth.admission,
    hash: auth.passwords.hash, notify: dependencies.notifyAccessRequests,
  });
  function requirePublicAuth(ctx: ApiContext) {
    if (!auth || auth.trustedProxy !== "gateway" || !ctx.clientIp) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Public authentication unavailable." });
    }
    return { repository: auth.repository, ip: ctx.clientIp };
  }
  const decide = createAccessRequestDecider({
    repository: dependencies.decisions,
    notify: dependencies.notifyAccessRequests,
    now: dependencies.now ?? (() => new Date()),
  });
  const setMemberStatus = dependencies.memberStatuses
    ? createMemberStatusUpdater(dependencies.memberStatuses) : undefined;
  const adminAccounts = dependencies.adminAccounts
    ? createAdminAccountsService(dependencies.adminAccounts) : undefined;
  function accountManagementError(error: unknown): never {
    if (error instanceof AdminAccountsForbiddenError) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
    }
    if (error instanceof AdminAccountsSelfRoleError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "You can't change your own role." });
    }
    if (error instanceof AdminAccountsInputError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid account management input." });
    }
    throw error;
  }
  async function requireAdmin(ctx: ApiContext) {
    const actor = await lookupBrowserSession(ctx.sessionToken, dependencies.sessions, dependencies.now);
    if (!actor || actor.role !== "admin" || actor.status !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
    }
    return actor;
  }
  async function requireAdminService(ctx: ApiContext) {
    const actor = await requireAdmin(ctx);
    if (!adminAccounts) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Account management unavailable" });
    }
    return { actor, service: adminAccounts };
  }
  async function requireActiveMember(ctx: ApiContext) {
    const actor = await lookupBrowserSession(ctx.sessionToken, dependencies.sessions, dependencies.now);
    if (!actor || actor.status !== "active" || !["user", "admin"].includes(actor.role)) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }
    return actor;
  }
  function historyError(error: unknown): never {
    if (error instanceof ListeningHistoryInputError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    if (error instanceof ListeningHistoryMediaUnavailableError) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Playable song not found." });
    }
    throw error;
  }
  function playbackQueueError(error: unknown): never {
    if (error instanceof PlaybackQueueError) {
      const code = error.code === "NOT_FOUND" ? "NOT_FOUND"
        : error.code === "CONFLICT" ? "CONFLICT" : "BAD_REQUEST";
      throw new TRPCError({ code, message: error.message });
    }
    throw error;
  }
  return trpc.router({
    library: trpc.router({
      listFiles: trpc.procedure.input(libraryListInputSchema.optional())
        .output(libraryFilePageSchema).query(async ({ ctx, input }) => {
          await requireActiveMember(ctx);
          if (!dependencies.library) {
            throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Library unavailable" });
          }
          try {
            return await dependencies.library.listFiles(input);
          } catch (error) {
            if (error instanceof LibraryRepositoryInputError) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid Library listing input." });
            }
            throw error;
          }
        }),
    }),
    playback: trpc.router({
        queue: trpc.router({
          open: trpc.procedure.input(playbackQueueOpenInputSchema)
            .output(playbackQueuePageSchema).mutation(async ({ ctx, input }) => {
              const actor = await requireActiveMember(ctx);
              if (!dependencies.playbackQueues) {
                throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Playback queue unavailable" });
              }
              try {
                return await dependencies.playbackQueues.open(actor.id, input);
              } catch (error) {
                return playbackQueueError(error);
              }
            }),
          page: trpc.procedure.input(playbackQueuePageRequestSchema)
            .output(playbackQueuePageSchema).query(async ({ ctx, input }) => {
              const actor = await requireActiveMember(ctx);
              if (!dependencies.playbackQueues) {
                throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Playback queue unavailable" });
              }
              try {
                return await dependencies.playbackQueues.page(actor.id, input.queueId, input.position);
              } catch (error) {
                return playbackQueueError(error);
              }
            }),
          edit: trpc.procedure.input(playbackQueueEditRequestSchema)
            .output(playbackQueuePageSchema).mutation(async ({ ctx, input }) => {
              const actor = await requireActiveMember(ctx);
              if (!dependencies.playbackQueues) {
                throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Playback queue unavailable" });
              }
              try {
                const { queueId, ...edit } = input;
                return await dependencies.playbackQueues.edit(actor.id, queueId, edit);
              } catch (error) {
                return playbackQueueError(error);
              }
            }),
        }),
        history: trpc.router({
          list: trpc.procedure.input(listeningHistoryListInputSchema.optional())
            .output(listeningHistoryPageSchema).query(async ({ ctx, input }) => {
              const actor = await requireActiveMember(ctx);
              if (!dependencies.playbackHistory) {
                throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Listening history unavailable" });
              }
              try {
                return await dependencies.playbackHistory.list(actor.id, input ?? {});
              } catch (error) {
                return historyError(error);
              }
            }),
          record: trpc.procedure.input(listeningHistoryRecordInputSchema)
            .output(listeningHistoryRecordResultSchema).mutation(async ({ ctx, input }) => {
              const actor = await requireActiveMember(ctx);
              if (!dependencies.playbackHistory) {
                throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Listening history unavailable" });
              }
              try {
                return await dependencies.playbackHistory.record(actor.id, input);
              } catch (error) {
                return historyError(error);
              }
            }),
          delete: trpc.procedure.input(listeningHistoryDeleteInputSchema)
            .mutation(async ({ ctx, input }) => {
              const actor = await requireActiveMember(ctx);
              if (!dependencies.playbackHistory) {
                throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Listening history unavailable" });
              }
              try {
                await dependencies.playbackHistory.delete(actor.id, input);
              } catch (error) {
                return historyError(error);
              }
              return null;
            }),
          privateSession: trpc.procedure.query(async ({ ctx }) => {
            const actor = await requireActiveMember(ctx);
            if (!dependencies.playbackHistory) {
              throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Listening history unavailable" });
            }
            return dependencies.playbackHistory.privateSession(actor.id);
          }),
          setPrivateSession: trpc.procedure.input(listeningHistoryPrivateSessionInputSchema)
            .mutation(async ({ ctx, input }) => {
              const actor = await requireActiveMember(ctx);
              if (!dependencies.playbackHistory) {
                throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Listening history unavailable" });
              }
              await dependencies.playbackHistory.setPrivateSession(actor.id, input.privateSession);
              return null;
            }),
        }),
    }),
    accounts: trpc.router({
      signIn: trpc.procedure.input(browserSignInInputSchema)
        .output(browserSignInResultSchema).mutation(async ({ ctx, input }) => {
          const { repository, ip } = requirePublicAuth(ctx);
          const result = await authenticate!(input.email, input.password, ip);
          if ("error" in result) return result;
          const session = await issueBrowserSession({
            userId: result.principal.id, ip, userAgent: ctx.userAgent,
          }, repository, { now: dependencies.now });
          return { principal: result.principal, token: session.token, expiresAt: session.expiresAt.toISOString() };
        }),
      requestAccess: trpc.procedure.input(accountAccessRequestInputSchema)
        .output(accountAccessRequestResultSchema).mutation(({ ctx, input }) => {
          const { ip } = requirePublicAuth(ctx);
          return requestAccess!(input, ip);
        }),
      signOut: trpc.procedure.mutation(async ({ ctx }) => {
        if (!auth) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Authentication unavailable." });
        await revokeBrowserSession(ctx.sessionToken, auth.repository);
        return null;
      }),
      session: trpc.procedure.output(accountPrincipalSchema.nullable()).query(({ ctx }) =>
        lookupBrowserSession(ctx.sessionToken, dependencies.sessions, dependencies.now)),
      pendingAccessRequestCount: trpc.procedure.output(pendingAccessRequestCountSchema)
        .query(async ({ ctx }) => {
          await requireAdmin(ctx);
          return dependencies.decisions.countPending();
        }),
      listAccounts: trpc.procedure.input(adminAccountListInputSchema.optional())
        .output(adminAccountPageSchema).query(async ({ ctx, input }) => {
          const { actor, service } = await requireAdminService(ctx);
          try {
            return await service.listAccounts(input ?? {}, actor);
          } catch (error) {
            return accountManagementError(error);
          }
        }),
      setMemberRole: trpc.procedure.input(setMemberRoleInputSchema).mutation(async ({ ctx, input }) => {
        const { actor, service } = await requireAdminService(ctx);
        try {
          await service.setMemberRole(input, actor);
        } catch (error) {
          accountManagementError(error);
        }
        return null;
      }),
      setMemberStatus: trpc.procedure.input(setMemberStatusInputSchema).mutation(async ({ ctx, input }) => {
        const actor = await lookupBrowserSession(ctx.sessionToken, dependencies.sessions, dependencies.now);
        if (!setMemberStatus) {
          throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Member status service unavailable" });
        }
        try {
          await setMemberStatus(input, actor);
        } catch (error) {
          if (error instanceof MemberStatusForbiddenError) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
          }
          if (error instanceof MemberStatusSelfChangeError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "You can't disable your own account." });
          }
          throw error;
        }
        return null;
      }),
      decideAccessRequest: trpc.procedure.input(decideAccessRequestInputSchema).mutation(async ({ ctx, input }) => {
        const actor = await lookupBrowserSession(ctx.sessionToken, dependencies.sessions, dependencies.now);
        try {
          await decide(input, actor);
        } catch (error) {
          if (error instanceof AccessRequestDecisionForbiddenError) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
          }
          throw error;
        }
        return null;
      }),
    }),
  });
}

export type AppRouter = ReturnType<typeof createRouter>;

function browserSessionCookie(header: string | undefined): string | null {
  if (!header || header.length > 8192) return null;
  let token: string | null = null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) return null;
    const name = pair.slice(0, separator).trim();
    if (name !== BROWSER_SESSION_COOKIE_NAME) continue;
    if (token !== null || pair.slice(0, separator).trimStart() !== name) return null;
    const value = pair.slice(separator + 1);
    // Browser session issuance uses unquoted base64url, never URL decoding or trimming.
    if (!browserSessionTokenSchema.safeParse(value).success) return null;
    token = value;
  }
  return token;
}

function sanitizedErrorName(error: unknown): string {
  const allowed = ["Error", "TypeError", "RangeError", "SyntaxError", "URIError",
    "EvalError", "ReferenceError", "AggregateError"];
  return error instanceof Error && allowed.includes(error.name) ? error.name : "Error";
}

function authenticatedGateway(rawHeaders: string[], expected: Buffer): boolean {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === GATEWAY_TOKEN_HEADER_NAME) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  const credential = values[0];
  return values.length === 1 && typeof credential === "string"
    && gatewayTokenSchema.safeParse(credential).success
    && timingSafeEqual(Buffer.from(credential, "ascii"), expected);
}

export function createApiServer(dependencies: ApiServerDependencies): FastifyInstance {
  if (!gatewayTokenSchema.safeParse(dependencies.gatewayToken).success) {
    throw new Error("Invalid API gateway configuration.");
  }
  if (dependencies.publicAuth && dependencies.publicAuth.trustedProxy !== "gateway") {
    throw new Error("Invalid API public authentication configuration.");
  }
  if (typeof dependencies.decisions?.decidePendingAccess !== "function"
      || typeof dependencies.decisions?.countPending !== "function"
      || typeof dependencies.notifyAccessRequests !== "function") {
    throw new Error("Invalid API decision configuration.");
  }
  const expectedGatewayToken = Buffer.from(dependencies.gatewayToken, "ascii");
  const app = Fastify({
    logger: false,
    trustProxy: false,
    // Router decoding/length failures precede onRequest; keep them behind the same boundary.
    frameworkErrors: (_error, request, reply) => {
      const authenticated = authenticatedGateway(request.raw.rawHeaders, expectedGatewayToken);
      reply.raw.writeHead(authenticated ? 400 : 401, {
        "cache-control": "private, no-store",
        "content-type": "application/json; charset=utf-8",
      });
      reply.raw.end(JSON.stringify({ error: authenticated ? "Invalid request" : "Unauthorized" }));
    },
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!authenticatedGateway(request.raw.rawHeaders, expectedGatewayToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("cache-control", "private, no-store");
    // Fastify's unsupported-method fallback skips request hooks and never dispatches a procedure.
    if (!authenticatedGateway(request.raw.rawHeaders, expectedGatewayToken)) {
      reply.code(401).type("application/json");
      return JSON.stringify({ error: "Unauthorized" });
    }
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
    const status = typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
      ? statusCode : 500;
    if (status === 500) dependencies.errors.error({ name: sanitizedErrorName(error) });
    if (_request.routeOptions.url === "/media/:id") {
      reply.removeHeader("content-length").removeHeader("content-range").removeHeader("accept-ranges");
      reply.type("application/json");
    }
    reply.code(status).send({ error: status === 500 ? "Internal server error" : "Invalid request" });
  });
  app.route<{ Params: { id: string } }>({
    method: ["GET", "HEAD"],
    url: "/media/:id",
    async handler(request, reply) {
      const actor = await lookupBrowserSession(
        browserSessionCookie(request.headers.cookie), dependencies.sessions, dependencies.now,
      );
      if (!actor || actor.status !== "active" || !["user", "admin"].includes(actor.role)) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id)) {
        return reply.code(400).send({ error: "Invalid media ID" });
      }
      if (!dependencies.libraryMedia) {
        return reply.code(503).send({ error: "Media unavailable" });
      }
      const controller = new AbortController();
      let stream: Readable | undefined;
      const cancel = () => {
        controller.abort();
        stream?.destroy();
      };
      request.raw.once("aborted", cancel);
      reply.raw.once("close", cancel);
      if (request.raw.aborted || reply.raw.destroyed) cancel();
      const detach = () => {
        request.raw.removeListener("aborted", cancel);
        reply.raw.removeListener("close", cancel);
      };
      let media: Awaited<ReturnType<typeof openLibraryPlaybackMedia>> | undefined;
      let transferred = false;
      try {
        media = await openLibraryPlaybackMedia(dependencies.libraryMedia, request.params.id, {
          signal: controller.signal,
        });
        const range = parseLibraryMediaByteRange(request.headers.range, media.metadata.sizeBytes);
        if (request.method === "HEAD") {
          await media.close();
        } else {
          const opened = media;
          let position = range.start;
          stream = new Readable({
            highWaterMark: LIBRARY_MEDIA_READ_MAX_BYTES,
            read() {
              void opened.read(position, Math.min(LIBRARY_MEDIA_READ_MAX_BYTES, range.end - position + 1))
                .then((bytes) => {
                  if (this.destroyed) return;
                  position += bytes.length;
                  this.push(bytes);
                  if (position > range.end) this.push(null);
                }, (error: unknown) => this.destroy(
                  error instanceof Error ? error : new Error("Media read failed"),
                ));
            },
            destroy(error, callback) {
              controller.abort();
              void opened.close().then(() => {
                if (error) dependencies.errors.error({ name: "LibraryMediaStreamError" });
                callback(error ? new Error("Media stream failed") : null);
              }, () => {
                dependencies.errors.error({ name: "LibraryMediaStreamError" });
                callback(new Error("Media stream failed"));
              });
            },
          });
          stream.once("close", detach);
          if (controller.signal.aborted || reply.raw.destroyed) stream.destroy();
        }
        reply.code(range.status)
          .type(media.metadata.contentType)
          .header("content-length", range.length)
          .header("accept-ranges", "bytes");
        if (range.contentRange) reply.header("content-range", range.contentRange);
        if (stream) {
          reply.send(stream);
          transferred = true;
          return reply;
        }
        return reply.send();
      } catch (error) {
        if (error instanceof LibraryPlaybackMediaError && error.code === "CANCELLED"
          && controller.signal.aborted && reply.raw.destroyed) return reply;
        if (error instanceof LibraryMediaRangeError) {
          await media?.close();
          return reply.code(416).header("content-range", error.contentRange)
            .header("accept-ranges", "bytes").send({ error: "Invalid media range" });
        }
        if (error instanceof LibraryPlaybackMediaError) {
          if (["NOT_FOUND", "NOT_VERIFIED", "FILE_UNAVAILABLE"].includes(error.code)) {
            return reply.code(404).send({ error: "Media not found" });
          }
          if (error.code === "UNSUPPORTED_ORIGINAL_FORMAT") {
            return reply.code(415).send({ error: "Unsupported media format" });
          }
        }
        throw error;
      } finally {
        if (!transferred) {
          detach();
          stream?.destroy();
          await media?.close();
        }
      }
    },
  });
  app.register(fastifyTRPCPlugin<AppRouter>, {
    prefix: "/trpc",
    trpcOptions: {
      router: createRouter(dependencies),
      createContext: ({ req }) => {
        const values: string[] = [];
        for (let i = 0; i < req.raw.rawHeaders.length; i += 2) {
          if (req.raw.rawHeaders[i]?.toLowerCase() === TRUSTED_CLIENT_IP_HEADER) {
            values.push(req.raw.rawHeaders[i + 1] ?? "");
          }
        }
        const ip = values.length === 1 ? trustedClientIpSchema.safeParse(values[0]) : null;
        return {
          sessionToken: browserSessionCookie(req.headers.cookie),
          clientIp: ip?.success ? ip.data : null,
          userAgent: req.headers["user-agent"],
        };
      },
      onError: ({ error }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          dependencies.errors.error({ name: sanitizedErrorName(error.cause) });
        }
      },
    },
  });
  return app;
}
