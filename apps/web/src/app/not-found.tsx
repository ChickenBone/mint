import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5">
      <h1 className="text-4xl font-extrabold tracking-tight">Nothing on this shelf</h1>
      <p className="mt-3 text-muted">That page doesn&rsquo;t exist, or it belongs to someone else&rsquo;s library.</p>
      <Link href="/" className="mt-8 self-start rounded-full bg-mint px-6 py-3 font-bold text-mint-ink hover:bg-mint-strong">
        Back to Mint
      </Link>
    </main>
  );
}
