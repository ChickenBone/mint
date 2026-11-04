import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Artwork } from "@/components/artwork";
import { FreshShelf } from "@/components/fresh-shelf";
import { getLibraryArtwork, getRecentlyReady } from "@/lib/data";
import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export default async function Home() {
  const [fresh, wall, user] = await Promise.all([getRecentlyReady(12), getLibraryArtwork(), getUser()]);
  return <>
    <section className="mx-auto grid min-h-[min(44rem,85svh)] max-w-7xl items-center gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[1.1fr_1fr] lg:gap-20 lg:py-24">
      <div>
        <h1 className="max-w-2xl text-[clamp(3.25rem,7vw,6rem)] font-bold leading-[1.02] tracking-[-0.04em]">A home for<br />your music.</h1>
        <p className="mt-7 max-w-lg text-lg leading-relaxed text-muted">The songs you love. The ones you haven’t found yet. Your own library, with room for both.</p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link href={user ? "/app" : "/request-access"} className="inline-flex min-h-12 items-center gap-3 rounded-full bg-mint px-6 font-semibold text-mint-ink hover:bg-mint-strong">{user ? "Open your music" : "Request access"}<ArrowRight className="size-4" /></Link>
          <Link href="/browse" className="inline-flex min-h-12 items-center rounded-full px-5 font-semibold text-muted ring-1 ring-line hover:text-fg">Look around</Link>
        </div>
        <p className="mt-7 text-xs leading-relaxed text-muted">Private listening for approved members.<br />Everyone’s welcome to browse. No public audio.</p>
      </div>
      {wall.length > 0 && <div aria-label="Artwork from the Mint library" className="grid grid-cols-2 gap-4 lg:gap-5">
        {wall.slice(0, 4).map((track) => <Artwork key={track.artworkUrl} track={track} eager className="w-full rounded-xl" />)}
      </div>}
    </section>
    <section className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-20">
      <div className="mb-8 flex items-end justify-between gap-5"><div><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">New to the collection.</h2><p className="mt-3 text-sm text-muted">Fresh arrivals, ready for their next listen.</p></div><Link href="/browse" className="inline-flex min-h-11 shrink-0 items-center gap-2 text-sm font-semibold text-muted hover:text-fg">View library<ArrowRight className="size-4" /></Link></div>
      <FreshShelf initial={fresh} feature={false} />
    </section>
    <section className="mx-auto grid max-w-7xl gap-10 border-y border-line px-5 py-14 sm:px-8 lg:grid-cols-2 lg:gap-20">
      <h2 className="max-w-xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl">A wider world.<br />A personal collection.</h2>
      <div><p className="max-w-lg text-base leading-relaxed text-muted">Explore country Top 50s, worldwide listening communities and independent music. See what’s already here and find something worth bringing home.</p><Link href="/charts" className="mt-5 inline-flex min-h-12 items-center gap-3 font-semibold">Explore the charts<ArrowRight className="size-4" /></Link></div>
    </section>
    <section id="how" className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
      <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Your music. Without the noise.</h2>
      <div className="mt-9 grid gap-8 md:grid-cols-3">
        {[
          ["Bring your favorites", "Connect YouTube Music likes and playlists, import Spotify playlist metadata, or listen to music already in your Plex library."],
          ["Make it your own", "Build playlists, follow a mix somewhere new, take a few albums offline, and pick up the queue on another device."],
          ["Stay with the song", "Listen in Mint’s own player, with lyrics and sound controls close by. The files stay on your server; originals stay protected."],
        ].map(([title, description]) => <div key={title}><h3 className="text-lg font-semibold">{title}</h3><p className="mt-3 max-w-lg text-sm leading-relaxed text-muted">{description}</p></div>)}
      </div>
      <Link href={user ? "/app" : "/request-access"} className="mt-10 inline-flex min-h-12 items-center gap-3 rounded-full bg-mint px-6 font-semibold text-mint-ink">{user ? "Back to your music" : "Make yourself at home"}<ArrowRight className="size-4" /></Link>
    </section>
  </>;
}
