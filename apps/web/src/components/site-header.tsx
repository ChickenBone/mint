import Link from "next/link";
import { getUser } from "@/lib/auth";
import { LiveDot } from "./live-dot";
import { Logo } from "./logo";

export async function SiteHeader() {
  const user = await getUser();
  return (
    <header className="sticky top-0 z-30 border-b border-line/60 bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 min-[400px]:gap-3 sm:gap-6 sm:px-8">
        <Logo />
        <nav aria-label="Public navigation" className="hidden items-center gap-5 text-sm font-medium text-muted sm:flex">
          <Link href="/browse" className="transition-colors hover:text-fg">Browse</Link>
          <Link href="/charts" className="transition-colors hover:text-fg">Charts</Link>
          <Link href="/#how" className="transition-colors hover:text-fg">How it works</Link>
        </nav>
        <span className="ml-auto hidden sm:block">
          <LiveDot />
        </span>
        <div className="ml-auto flex items-center gap-1 sm:ml-0 sm:gap-2">
          {user ? (
            <Link href="/app" className="whitespace-nowrap rounded-full bg-fg px-4 py-2 text-sm font-semibold text-bg transition hover:scale-[1.03]">
              Open Mint
            </Link>
          ) : (
            <>
              <Link href="/login" className="whitespace-nowrap rounded-full px-2 py-2 text-sm font-semibold text-muted transition-colors hover:text-fg sm:px-4">
                Sign in
              </Link>
              <Link href="/request-access" className="whitespace-nowrap rounded-full bg-mint px-3.5 py-2 text-sm font-semibold text-mint-ink sm:px-4 transition hover:scale-[1.03] hover:bg-mint-strong">
                Request access
              </Link>
            </>
          )}
        </div>
      </div>
      <nav aria-label="Public navigation" className="flex gap-6 border-t border-line/60 px-5 text-sm font-medium text-muted sm:hidden">
        <Link href="/browse" className="inline-flex min-h-11 items-center hover:text-fg">Browse</Link>
        <Link href="/charts" className="inline-flex min-h-11 items-center hover:text-fg">Charts</Link>
        <Link href="/#how" className="inline-flex min-h-11 items-center hover:text-fg">How it works</Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line/60">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-8 text-sm text-faint sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p>Mint is a private library for approved members. Public visitors can browse; members can listen.</p>
        <Link href="/activity" className="inline-flex min-h-11 items-center text-muted hover:text-fg">Library activity</Link>
      </div>
    </footer>
  );
}
