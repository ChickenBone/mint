import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE, sha256 } from "@mint/core/crypto";
import { getDb } from "@mint/core/db";
import { spotifyPlaylists } from "@mint/core/spotify-db";
import { spotifyConfigured, spotifyExtended } from "@mint/core/spotify";
import { spotifyAccountView } from "@mint/core/spotify-store";
import { asc, eq } from "drizzle-orm";
import { SettingsView } from "@/components/app/settings-view";
import { requireUser } from "@/lib/auth";
import { getPendingCount, getPlaylists, getYoutubeAccount, syncStateOf } from "@/lib/data";
import { DeviceStore } from "@/lib/devices-store";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  const db = getDb();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const store = new DeviceStore(db, { userId: user.id, sessionId: sha256(cookie ?? "") });

  const [acct, playlists, spAccount, spPlaylists, devices, parties, pendingCount] = await Promise.all([
    getYoutubeAccount(user.id),
    getPlaylists(user.id),
    spotifyAccountView(db, user.id),
    db
      .select()
      .from(spotifyPlaylists)
      .where(eq(spotifyPlaylists.userId, user.id))
      .orderBy(asc(spotifyPlaylists.title), asc(spotifyPlaylists.id))
      .limit(100),
    store.list(),
    store.listParties(),
    user.role === "admin" ? getPendingCount() : Promise.resolve(0),
  ]);

  return (
    <SettingsView
      user={{ id: user.id, name: user.name, email: user.email, role: user.role }}
      pendingManagementCount={pendingCount}
      youtubeAccount={
        acct
          ? {
              channelTitle: acct.channelTitle,
              email: acct.email,
              lastSyncedAt: acct.lastSyncedAt ? acct.lastSyncedAt.toISOString() : null,
              musicOnly: acct.musicOnly,
              autoSync: acct.autoSync,
              syncState: syncStateOf(acct),
            }
          : null
      }
      youtubePlaylists={playlists.map((p) => ({
        id: p.id,
        title: p.title,
        itemCount: p.itemCount,
        syncEnabled: p.syncEnabled,
      }))}
      spotifyConfigured={spotifyConfigured()}
      spotifyExtended={spotifyExtended()}
      spotifyAccount={
        spAccount
          ? {
              displayName: spAccount.displayName,
              status: spAccount.status,
              error: spAccount.error,
              autoSync: spAccount.autoSync,
              lastSyncedAt: spAccount.lastSyncedAt ? spAccount.lastSyncedAt.toISOString() : null,
              nextSyncAt: spAccount.nextSyncAt.toISOString(),
            }
          : null
      }
      spotifyPlaylists={spPlaylists.map((p) => ({
        id: p.id,
        title: p.title,
        sourceTotal: p.sourceTotal,
        matchedTotal: p.matchedTotal,
        syncEnabled: p.syncEnabled,
        status: p.status,
        error: p.error,
        lastSyncedAt: p.lastSyncedAt ? p.lastSyncedAt.toISOString() : null,
      }))}
      initialDevices={devices}
      initialParties={parties}
    />
  );
}
