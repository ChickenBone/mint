import type { Metadata } from "next";
import Link from "next/link";
import { ChartBrowser } from "@/components/app/chart-browser";
import { getUser } from "@/lib/auth";
import { chartPage } from "@/lib/chart-service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Music charts" };

export default async function Charts() {
  const user = await getUser();
  return (
    <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">Find your next favorite.</h1>
          <p className="mt-4 max-w-prose text-base leading-relaxed text-muted">
            Explore the charts and see what&rsquo;s already in Mint. Public browsing is audio-free.
          </p>
        </div>
        <Link
          href={user ? "/app/discover/charts" : "/request-access"}
          className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong"
        >
          {user ? "Open member charts" : "Request access to listen"}
        </Link>
      </div>
      <ChartBrowser initial={await chartPage("apple-us", null)} member={false} />
    </div>
  );
}
