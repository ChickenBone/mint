import type { Metadata } from "next";
import Link from "next/link";
import { RequestForm } from "./request-form";

export const metadata: Metadata = { title: "Request access" };

export default function RequestAccessPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-12 px-5 py-20 sm:px-8 md:grid-cols-[1fr_24rem]">
      <div>
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">Ask for a seat</h1>
        <p className="mt-4 max-w-md text-lg text-muted">
          Mint runs on one home server, so seats are limited. Choose your sign-in details now; they start working once the admin approves you.
        </p>
        <ul className="mt-8 flex max-w-md flex-col gap-3 text-muted">
          <li>Then link YouTube Music with Google, read-only.</li>
          <li>Pick which playlists to bring along. Likes sync automatically.</li>
          <li>Install Plexamp and sign in to the server you&rsquo;re invited to.</li>
        </ul>
        <p className="mt-8 text-sm text-muted">
          Already approved?{" "}
          <Link href="/login" className="font-semibold text-fg underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
      <RequestForm />
    </div>
  );
}
