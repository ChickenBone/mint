import Link from "next/link";

export function MintMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="16" fill="var(--color-mint)" />
      <path d="M9 21.5c0-6.6 4.6-11.2 14-11.5-.2 9.4-4.9 14-11.5 14-.9 0-1.7-.1-2.5-.3Z" fill="var(--color-mint-ink)" />
      <path d="M9.5 22.5 17 15" stroke="var(--color-mint)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
      <MintMark />
      Mint
    </Link>
  );
}
