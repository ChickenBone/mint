"use client";

import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { requestAccess, type FormState } from "@/app/actions/auth";
import { Field, SubmitButton } from "@/components/form";

export function RequestForm() {
  const [state, action] = useActionState<FormState, FormData>(requestAccess, {});
  if (state.ok) {
    return (
      <div className="rounded-2xl border border-line/70 bg-elevated p-6 sm:p-8" role="status">
        <h2 className="flex items-center gap-3 text-2xl font-bold"><CheckCircle2 className="size-7 shrink-0 text-mint" aria-hidden />Request sent</h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
          Your administrator will review your request. Approval timing depends on the server; your account is not active yet.
        </p>
        <div className="mt-5 border-t border-line pt-5 text-sm">
          <h3 className="font-semibold">What happens next</h3>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted">
            <li>Keep the email and password you just chose—they activate as soon as you&rsquo;re approved.</li>
            <li>Sign in at the Sign in page once approved to listen in your browser.</li>
            <li>Find a song in the library and press play. Make your own playlists in Your music.</li>
          </ol>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong"
          >
            Go to Sign in
          </Link>
        </div>
      </div>
    );
  }
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <Field label="Name" name="name" autoComplete="name" required error={fe.name} defaultValue={v.name} />
      <Field label="Email" name="email" type="email" autoComplete="email" required error={fe.email} defaultValue={v.email} />
      <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={10} error={fe.password} hint="At least 10 characters." />
      <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" required error={fe.confirm} />
      <div>
        <label htmlFor="f-note" className="mb-1.5 block text-sm font-semibold">
          Note for the admin <span className="font-normal text-faint">(optional)</span>
        </label>
        <textarea
          id="f-note"
          name="note"
          rows={3}
          maxLength={500}
          defaultValue={v.note}
          placeholder="How do you know us?"
          className="w-full rounded-lg bg-elevated px-4 py-3 text-fg placeholder:text-faint outline-none ring-1 ring-line transition hover:ring-faint focus:ring-2 focus:ring-mint"
        />
      </div>
      {/* Honeypot: hidden from people, tempting to bots. */}
      <div aria-hidden className="absolute -left-[9999px]">
        <label>
          Website <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {state.error && <p className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">{state.error}</p>}
      <SubmitButton pendingLabel="Sending request" className="w-full">Send request</SubmitButton>
    </form>
  );
}
