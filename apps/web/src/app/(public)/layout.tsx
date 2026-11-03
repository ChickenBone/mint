import { PlayerBar } from "@/components/player-bar";
import { SiteFooter, SiteHeader } from "@/components/site-header";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col pb-20">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
      <PlayerBar className="fixed inset-x-0 bottom-0 z-40" />
    </div>
  );
}
