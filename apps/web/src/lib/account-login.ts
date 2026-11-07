import "server-only";
import { getDb, schema } from "@mint/core/db";
import { hash, verify } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import { rateLimit } from "./rate-limit";

let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hash("mint-timing-equaliser"));

export async function authenticateAccount(email: string, password: string, ip: string) {
  if (!(await rateLimit(`login:ip:${ip}`, 20, 900)) || !(await rateLimit(`login:email:${email.toLowerCase()}`, 8, 900))) {
    return { error: "Too many attempts. Wait 15 minutes and try again.", status: 429 } as const;
  }
  const user = await getDb().query.users.findFirst({ where: sql`lower(${schema.users.email}) = ${email.toLowerCase()}` });
  let valid: boolean;
  try { valid = await verify(user?.passwordHash ?? (await getDummyHash()), password); }
  catch (error) {
    console.error("[auth] password verification failed", error instanceof Error ? error.name : "Unknown failure");
    return { error: "Sign-in is unavailable. Try again later.", status: 503 } as const;
  }
  if (!user || !valid) return { error: "That email and password don't match an account.", status: 401 } as const;
  if (user.status === "pending") {
    return { error: "Your request is still waiting for approval. You'll be able to sign in once an admin lets you in.", status: 403 } as const;
  }
  if (user.status !== "active") return { error: "This account can't sign in. Contact the admin.", status: 403 } as const;
  return { user } as const;
}
