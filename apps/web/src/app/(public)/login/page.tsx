import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getUser()) redirect("/app");
  const { next } = await searchParams;
  return (
    <div className="mx-auto w-full max-w-sm px-5 py-20">
      <h1 className="text-4xl font-bold tracking-tight">Welcome back.</h1>
      <p className="mt-3 text-muted">Sign in to your listening room.</p>
      <div className="mt-10">
        <LoginForm next={typeof next === "string" ? next : undefined} />
      </div>
      <p className="mt-8 text-sm text-muted">
        No account yet?{" "}
        <Link href="/request-access" className="font-semibold text-fg underline-offset-4 hover:underline">
          Request access
        </Link>
      </p>
      <p className="mt-4 text-sm text-muted">Requested an account? You can sign in once an administrator approves it.</p>
    </div>
  );
}
