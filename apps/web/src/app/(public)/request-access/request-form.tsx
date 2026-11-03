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
      <div className="rounded-2xl bg-elevated p-8" role="status">
        <CheckCircle2 className="size-8 text-mint" aria-hidden />
        <h2 className="mt-4 text-2xl font-bold">Request sent</h2>
        <p className="mt-2 text-muted">
          The admin will review it soon. Once you&rsquo;re approved, sign in with the email and password you just chose.
        </p>
        <Link href="/" className="mt-6 inline-block font-semibold text-mint hover:underline">
          Back to the live board
        </Link>
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
