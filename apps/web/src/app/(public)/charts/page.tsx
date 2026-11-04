import type { Metadata } from "next";
import { ChartBrowser } from "@/components/app/chart-browser";
import { chartPage } from "@/lib/chart-service";
import { getUser } from "@/lib/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Music charts" };
export default async function Charts() {
  const user = await getUser();
  return <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
    <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">Find your next favorite.</h1>
    <p className="mt-4 mb-12 max-w-2xl text-base leading-relaxed text-muted">Explore the charts and see what’s in Mint. Public browsing is audio-free. <Link href={user ? "/app/discover" : "/request-access"} className="text-fg underline underline-offset-4">{user ? "Open member discovery to listen." : "Request an account to listen and grow the library."}</Link></p>
    <ChartBrowser initial={await chartPage("apple-us", null)} member={false} />
  </div>;
}
