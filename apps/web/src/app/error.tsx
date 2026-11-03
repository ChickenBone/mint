"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-[60dvh] max-w-md flex-col justify-center px-5">
      <h1 className="text-3xl font-extrabold tracking-tight">Something skipped</h1>
      <p className="mt-3 text-muted">Mint couldn&rsquo;t load this page. The database or Redis may be restarting. Try again in a few seconds.</p>
      <button type="button" onClick={reset} className="mt-8 self-start rounded-full bg-fg px-6 py-3 font-bold text-bg hover:scale-[1.03]">
        Try again
      </button>
    </main>
  );
}
