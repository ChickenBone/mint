"use client";

import clsx from "clsx";
import { useFormStatus } from "react-dom";
import { Button, Input } from "./ui/primitives";

export function Field({
  label,
  name,
  error,
  hint,
  className,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; name: string; error?: string; hint?: string }) {
  return <Input label={label} name={name} error={error} hint={hint} className={className} {...input} />;
}

export function SubmitButton({ children, pendingLabel, className }: { children: React.ReactNode; pendingLabel: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      loading={pending}
      className={clsx("rounded-full px-8 font-bold", className)}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
