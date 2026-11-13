import { timingSafeEqual } from "node:crypto";
import {
  accountPrincipalSchema, BROWSER_SESSION_COOKIE_NAME, browserSessionTokenSchema,
  decideAccessRequestInputSchema, GATEWAY_TOKEN_HEADER_NAME, gatewayTokenSchema,
  libraryListInputSchema, libraryFilePageSchema,
  setMemberStatusInputSchema,
  adminAccountListInputSchema, adminAccountPageSchema, setMemberRoleInputSchema,
} from "@mint/contracts";
import {
  AccessRequestDecisionForbiddenError, createAccessRequestDecider, lookupBrowserSession,
  createMemberStatusUpdater, MemberStatusForbiddenError, MemberStatusSelfChangeError,
  type AccessRequestDecisionRepository, type SessionLookupRepository,
  type MemberStatusRepository,
  createAdminAccountsService, AdminAccountsForbiddenError, AdminAccountsSelfRoleError,
  AdminAccountsInputError, type AdminAccountsRepository,
} from "@mint/domain-accounts";
import { LibraryRepositoryInputError, type LibraryRepository } from "@mint/domain-library";
import { initTRPC, TRPCError } from "@trpc/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify, { type FastifyInstance } from "fastify";

export interface ApiErrorLogger {
  error(event: { name: string }): void;
}

export interface ApiServerDependencies {
  /** Explicit server-only service credential, never a user identity. */
  gatewayToken: string;
  sessions: SessionLookupRepository;
  decisions: AccessRequestDecisionRepository;
  memberStatuses?: MemberStatusRepository;
  adminAccounts?: AdminAccountsRepository;
  library?: Pick<LibraryRepository, "listFiles">;
  notifyAccessRequests(notification: { pending: number }): Promise<void>;
  errors: ApiErrorLogger;
  now?: () => Date;
}

interface ApiContext {
  sessionToken: string | null;
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
  async function requireAdminService(ctx: ApiContext) {
    const actor = await lookupBrowserSession(ctx.sessionToken, dependencies.sessions, dependencies.now);
    if (!actor || actor.role !== "admin" || actor.status !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
    }
    if (!adminAccounts) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Account management unavailable" });
    }
    return { actor, service: adminAccounts };
  }
  return trpc.router({
    library: trpc.router({
      listFiles: trpc.procedure.input(libraryListInputSchema.optional())
        .output(libraryFilePageSchema).query(async ({ ctx, input }) => {
          const actor = await lookupBrowserSession(ctx.sessionToken, dependencies.sessions, dependencies.now);
          if (!actor || actor.status !== "active" || !["user", "admin"].includes(actor.role)) {
            throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorized" });
          }
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
    accounts: trpc.router({
      session: trpc.procedure.output(accountPrincipalSchema.nullable()).query(({ ctx }) =>
        lookupBrowserSession(ctx.sessionToken, dependencies.sessions, dependencies.now)),
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
    reply.code(status).send({ error: status === 500 ? "Internal server error" : "Invalid request" });
  });
  app.register(fastifyTRPCPlugin<AppRouter>, {
    prefix: "/trpc",
    trpcOptions: {
      router: createRouter(dependencies),
      createContext: ({ req }) => ({ sessionToken: browserSessionCookie(req.headers.cookie) }),
      onError: ({ error }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          dependencies.errors.error({ name: sanitizedErrorName(error.cause) });
        }
      },
    },
  });
  return app;
}
