import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import { RealtimeProvider } from "@/components/realtime";
import { InstallProvider } from "@/components/install-app";
import "./globals.css";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_URL ?? "https://mint.chickenbone.dev"),
  title: { default: "Mint — Self-hosted music streaming with Plex", template: "%s · Mint" },
  description: "Your music, with room for more. Listen to your Plex library, explore charts, sync YouTube likes and bring your playlists home.",
  openGraph: {
    title: "Mint — Self-hosted music streaming with Plex",
    description: "Your music library, one self-hosted player. Bring together Plex music, YouTube Music likes and Spotify playlist matches in Mint.",
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
