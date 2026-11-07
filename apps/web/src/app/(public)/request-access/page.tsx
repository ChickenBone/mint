import type { Metadata } from "next";
import Link from "next/link";
import { RequestForm } from "./request-form";

export const metadata: Metadata = { title: "Request access" };

export default function RequestAccessPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-12 px-5 py-16 sm:px-8 md:grid-cols-[1fr_24rem] md:py-20">
      <div>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Your music starts here.</h1>
        <p className="mt-4 max-w-prose text-lg text-muted">
          Request a place in this private listening room. Choose your sign-in details now; your account opens after an administrator approves it.
        </p>
        <ol className="mt-8 flex max-w-prose list-decimal flex-col gap-3 pl-5 text-sm leading-relaxed text-muted">
          <li>Submit your name, email and password below.</li>
          <li>Your administrator reviews the request. Approval timing depends on the server.</li>
          <li>Once approved, sign in, find a song, and press play. No other music-service account is needed.</li>
        </ol>
        <p className="mt-8 text-sm text-muted">
          Already approved?{" "}
          <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-fg underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
      <RequestForm />
    </div>
  );
}
