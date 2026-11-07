import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import { RealtimeProvider } from "@/components/realtime";
import { InstallProvider } from "@/components/install-app";
import "./globals.css";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });

// Mobile Chrome annotates the document and form controls before hydration.
const stripChromeFormMarks = `(function(){var names=["__gcruniqueid","__gcrremoteframetoken"];function strip(node){if(!node||node.nodeType!==1)return;for(var i=0;i<names.length;i++)node.removeAttribute(names[i]);if(!node.querySelectorAll)return;var list=node.querySelectorAll("[__gcruniqueid],[__gcrremoteframetoken]");for(var j=0;j<list.length;j++)for(var i=0;i<names.length;i++)list[j].removeAttribute(names[i]);}strip(document.documentElement);var observer=new MutationObserver(function(records){for(var r=0;r<records.length;r++){var rec=records[r];if(rec.type==="attributes")strip(rec.target);for(var n=0;n<rec.addedNodes.length;n++)strip(rec.addedNodes[n]);}});observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:names});window.addEventListener("load",function(){observer.disconnect();},{once:true});})();`;

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
    <html lang="en" className={figtree.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: stripChromeFormMarks }} />
      </head>
      <body className="min-h-dvh bg-bg font-sans text-fg">
        <RealtimeProvider>
          <InstallProvider>{children}</InstallProvider>
        </RealtimeProvider>
      </body>
    </html>
  );
}
