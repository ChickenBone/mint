import type { CatalogQuery, MintApi } from "@mint/client";

export async function loadLibrary(api: Pick<MintApi, "collections" | "catalog"> | null,
  filter: NonNullable<CatalogQuery["type"]>, start: number, signal: AbortSignal) {
  if (!api) throw new Error("Sign in to load your library.");
  const [native, catalog] = await Promise.all([
    api.collections(signal), api.catalog({ type: filter, size: 100, start }, signal),
  ]);
  return { native, catalog };
}
