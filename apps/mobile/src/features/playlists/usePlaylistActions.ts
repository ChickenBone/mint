import { useState } from "react";
import type { CollectionDetail, MintApi } from "@mint/client";
import { copyPlaylist, deletePlaylist, movePlaylistEntry, removePlaylistEntry, renamePlaylist } from "./playlist-model";

type Options = {
  api: Pick<MintApi, "mutateCollection" | "createCollection"> | null; id: string; source?: string;
  metadata: CollectionDetail | null | undefined; title: string; reload(): void;
  onCopied(id: string): void; onDeleted(): void;
};

export function usePlaylistActions({ api, id, source, metadata, title, reload, onCopied, onDeleted }: Options) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingSongs, setEditingSongs] = useState(false);

  async function act(action: () => Promise<unknown>, fallback: string) {
    setBusy(true); setError(null);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : fallback); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!api || !metadata) return;
    await act(async () => { await renamePlaylist(api, id, metadata, name); setEditing(false); reload(); },
      "The playlist could not be renamed.");
  }
  async function copy() {
    if (!api) return;
    await act(async () => { const copy = await copyPlaylist(api, id, source, title); onCopied(copy.id); },
      "This playlist could not be copied.");
  }
  async function removePlaylist() {
    if (!api || !metadata) return;
    await act(async () => { await deletePlaylist(api, id, metadata); onDeleted(); }, "This playlist could not be deleted.");
    setDeleting(false);
  }
  async function moveEntry(entryId: string, direction: -1 | 1) {
    if (!api || !metadata) return;
    await act(async () => { await movePlaylistEntry(api, id, metadata, entryId, direction); reload(); },
      "This song could not be moved.");
  }
  async function removeEntry(entryId: string) {
    if (!api || !metadata) throw new Error("Reload this playlist.");
    await removePlaylistEntry(api, id, metadata, entryId); reload();
  }
  return { editing, setEditing, name, setName, busy, error, deleting, setDeleting, editingSongs, setEditingSongs,
    save, copy, removePlaylist, moveEntry, removeEntry };
}
