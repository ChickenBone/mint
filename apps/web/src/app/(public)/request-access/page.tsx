import type { Metadata } from "next";
import Link from "next/link";
import { RequestForm } from "./request-form";

export const metadata: Metadata = { title: "Request access" };

export default function RequestAccessPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-12 px-5 py-16 sm:px-8 md:grid-cols-[1fr_24rem] md:py-20">
      <div>
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">Ask for a seat</h1>
        <p className="mt-4 max-w-prose text-lg text-muted">
          Mint runs on one home server, so seats are limited. Choose your sign-in details now; they start working as soon as an admin approves your request.
        </p>
        <ol className="mt-8 flex max-w-prose list-decimal flex-col gap-3 pl-5 text-sm leading-relaxed text-muted">
          <li>Submit your name, email and password below.</li>
          <li>An admin reviews pending requests in Management—usually within a day.</li>
          <li>Once approved, sign in to Mint in your browser, explore the library, and optionally link YouTube Music or Spotify in read-only mode.</li>
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
