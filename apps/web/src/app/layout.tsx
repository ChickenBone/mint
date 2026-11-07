import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import { RealtimeProvider } from "@/components/realtime";
import { InstallProvider } from "@/components/install-app";
import "./globals.css";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_URL ?? "https://mint.chickenbone.dev"),
  title: { default: "Mint — Your music, with room to wander", template: "%s · Mint" },
  description: "Explore a shared music library, build personal playlists, and listen in Mint’s own player. Browse the public catalog or request access.",
  openGraph: {
    title: "Mint — Your music, with room to wander",
    description: "Explore a shared music library, build personal playlists, and listen in Mint’s own player.",
    type: "website",
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Mint", statusBarStyle: "black-translucent" },
  icons: { icon: "/api/app-icon/192", apple: "/api/app-icon/192" },
};

export const viewport: Viewport = { themeColor: "#101311", colorScheme: "dark", viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.variable}>
      <body className="min-h-dvh bg-bg font-sans text-fg">
        <RealtimeProvider>
          <InstallProvider>{children}</InstallProvider>
        </RealtimeProvider>
      </body>
    </html>
  );
}
