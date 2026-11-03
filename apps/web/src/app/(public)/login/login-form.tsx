"use client";

import { useActionState } from "react";
import { login, type FormState } from "@/app/actions/auth";
import { Field, SubmitButton } from "@/components/form";

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState<FormState, FormData>(login, {});
  return (
    <form action={action} className="flex flex-col gap-5">
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus defaultValue={state.values?.email} />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      {state.error && <p className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">{state.error}</p>}
      <SubmitButton pendingLabel="Signing in" className="w-full">Sign in</SubmitButton>
    </form>
  );
}
