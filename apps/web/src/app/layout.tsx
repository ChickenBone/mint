import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import { RealtimeProvider } from "@/components/realtime";
import "./globals.css";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_URL ?? "https://mint.chickenbone.dev"),
  title: { default: "Mint", template: "%s · Mint" },
  description: "Your YouTube Music likes, downloaded to our own server and played in Plexamp. Watch every song land in real time.",
  openGraph: { title: "Mint", description: "Your likes, on our server, in Plexamp.", type: "website" },
};

export const viewport: Viewport = { themeColor: "#0a0d0c", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.variable}>
      <body className="min-h-dvh bg-bg font-sans text-fg">
        <RealtimeProvider>
          {children}
        </RealtimeProvider>
      </body>
    </html>
  );
}
