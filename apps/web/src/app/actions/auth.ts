"use server";

import { CHANNEL, publish } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { hash } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession, destroySession } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { authenticateAccount } from "@/lib/account-login";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
  /** Echoed back so React's post-action form reset doesn't wipe what the user typed. Never includes passwords. */
  values?: Record<string, string>;
}

const loginSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
  next: z.string().optional(),
});

export async function login(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(form));
  const values = { email: String(form.get("email") ?? "").slice(0, 200) };
  if (!parsed.success) return { error: "Enter your email and password.", values };
  const { email, password } = parsed.data;
  const ip = await clientIp();
  const result = await authenticateAccount(email, password, ip);
  if ("error" in result) return { error: result.error, values };
  await createSession(result.user.id);
  const next = parsed.data.next;
  redirect(next && next.startsWith("/app") ? next : "/app");
}

export async function logout() {
  await destroySession();
  redirect("/");
}

const requestSchema = z
  .object({
    name: z.string().trim().min(1, "Tell us your name.").max(80),
    email: z.email("Enter a valid email address.").max(200),
    password: z.string().min(10, "Use at least 10 characters.").max(200),
    confirm: z.string(),
    note: z.string().trim().max(500).optional(),
    website: z.string().max(0).optional(), // honeypot
  })
  .refine((d) => d.password === d.confirm, { path: ["confirm"], message: "Passwords don't match." });

export async function requestAccess(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = requestSchema.safeParse(Object.fromEntries(form));
  const values = Object.fromEntries(["name", "email", "note"].map((k) => [k, String(form.get(k) ?? "").slice(0, 500)]));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    return { fieldErrors, values };
  }
  const ip = await clientIp();
  if (!(await rateLimit(`request:ip:${ip}`, 5, 3600))) return { error: "Too many requests from your network. Try again in an hour.", values };

  const db = getDb();
  const { name, email, password, note } = parsed.data;
  const existing = await db.query.users.findFirst({ where: sql`lower(${schema.users.email}) = ${email.toLowerCase()}` });
  // Same response whether or not the email exists, to avoid account enumeration.
  if (!existing) {
    await db.insert(schema.users).values({ name, email, passwordHash: await hash(password), requestNote: note || null });
    const pending = await db.$count(schema.users, eq(schema.users.status, "pending"));
    await publish(getRedis(), CHANNEL.admin, { type: "access-request", data: { pending } });
  }
  return { ok: true };
}
