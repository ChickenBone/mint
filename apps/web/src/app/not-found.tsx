import Link from "next/link";
import { Disc3 } from "lucide-react";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5">
      <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-wider text-muted uppercase">
        <Disc3 className="size-4" aria-hidden />
        <span>404 · Not found</span>
      </div>
      <h1 className="mt-2 text-4xl font-extrabold tracking-tight">Nothing on this shelf</h1>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
        That page doesn&rsquo;t exist, or it belongs to someone else&rsquo;s library.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href="/app"
          className="inline-flex min-h-11 items-center rounded-full bg-mint px-6 font-bold text-mint-ink hover:bg-mint-strong"
        >
          Open Mint
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold text-fg hover:bg-hover"
        >
          Public home
        </Link>
      </div>
    </main>
  );
}
