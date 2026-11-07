import Link from "next/link";
import { getUser } from "@/lib/auth";
import { Logo } from "./logo";

export async function SiteHeader() {
  const user = await getUser();
  return (
    <header className="sticky top-0 z-30 border-b border-line/60 bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 sm:gap-6 sm:px-8">
        <Logo />
        <nav aria-label="Public navigation" className="flex items-center gap-1 text-sm font-medium text-muted sm:ml-4 sm:gap-4">
          <Link href="/browse" className="inline-flex min-h-11 items-center px-2 transition-colors hover:text-fg">Browse</Link>
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {user ? (
            <Link href="/app" className="inline-flex min-h-11 items-center whitespace-nowrap rounded-full bg-fg px-3 py-2 text-sm font-semibold text-bg transition-colors hover:bg-white sm:px-4">
              Open Mint
            </Link>
          ) : (
            <Link href="/login" className="inline-flex min-h-11 items-center whitespace-nowrap rounded-full px-3 py-2 text-sm font-semibold text-muted transition-colors hover:text-fg sm:px-4">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line/60">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-8 text-sm text-faint sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className="max-w-prose">A shared music library, personal playlists, and a place to listen in Mint.</p>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/browse" className="inline-flex min-h-11 items-center text-muted hover:text-fg">Browse</Link>
          <Link href="/activity" className="inline-flex min-h-11 items-center text-muted hover:text-fg">Library activity</Link>
        </div>
      </div>
    </footer>
  );
}
