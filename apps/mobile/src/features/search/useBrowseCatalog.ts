import type { BrowseCategoryPage, CatalogPage, ChartDefinition, Discovery, MintApi } from "@mint/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acceptFacetPage, facetOrder, mixTitles, nextFacetPage, type FacetPages, type MixMode,
} from "./browse-model";

type BrowseApi = Pick<MintApi, "discover" | "catalog" | "charts" | "browseCategories">;
export type SourceKey = MixMode | "albums" | "charts";
export type SourceState =
  | { status: "loading" }
  | { status: "ready"; data: Discovery | CatalogPage | { charts: ChartDefinition[] } }
  | { status: "error"; error: string };
const mixModes = Object.keys(mixTitles) as MixMode[];
export const sourceKeys: SourceKey[] = [...mixModes, "albums", "charts"];
const failure = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

function loadSource(api: BrowseApi, key: SourceKey, signal: AbortSignal) {
  if (key === "albums") return api.catalog({ type: "album", sort: "newest", size: 1 }, signal);
  if (key === "charts") return api.charts(signal);
  return api.discover(key, signal);
}

const none: Partial<Record<SourceKey, SourceState>> = {};
const loading: SourceState = { status: "loading" };
const signedOut: SourceState = { status: "error", error: "Sign in to browse." };
type Sources = { api: BrowseApi | null; byKey: Partial<Record<SourceKey, SourceState>> };
const noPages: FacetPages = {};
type Facets = { api: BrowseApi | null; pages: FacetPages; loading: boolean; error: string | null };

/**
 * Search browse data for one signed-in API. Each source loads and fails independently with its own error,
 * and everything (including in-flight category pages) is discarded when the account or server changes.
 */
export function useBrowseCatalog(api: BrowseApi | null, fillTarget = 12) {
  const [sources, setSources] = useState<Sources>({ api: null, byKey: {} });
  const controllers = useRef(new Map<SourceKey, AbortController>());
  const run = useCallback((owner: BrowseApi, key: SourceKey) => {
    controllers.current.get(key)?.abort();
    const controller = new AbortController();
    controllers.current.set(key, controller);
    const settle = (state: SourceState) => {
      if (controller.signal.aborted) return;
      controllers.current.delete(key);
      setSources((previous) => ({ api: owner, byKey: { ...(previous.api === owner ? previous.byKey : {}), [key]: state } }));
    };
    void loadSource(owner, key, controller.signal).then((data) => settle({ status: "ready", data }))
      .catch((reason: unknown) => settle({ status: "error", error: failure(reason, "This section could not load.") }));
  }, []);
  useEffect(() => {
    if (!api) return;
    const active = controllers.current;
    for (const key of sourceKeys) run(api, key);
    return () => { for (const controller of active.values()) controller.abort(); active.clear(); };
  }, [api, run]);
  const byKey = sources.api === api ? sources.byKey : none;
  const states = useMemo(() => Object.fromEntries(sourceKeys.map((key) => [key,
    api ? byKey[key] ?? loading : signedOut])) as Record<SourceKey, SourceState>, [api, byKey]);
  const retrySources = useCallback((keys: SourceKey[]) => {
    if (!api) return;
    const failed = keys.filter((key) => byKey[key]?.status === "error");
    if (!failed.length) return;
    setSources((previous) => previous.api === api ? { api, byKey: { ...previous.byKey,
      ...Object.fromEntries(failed.map((key) => [key, { status: "loading" }])) } } : previous);
    for (const key of failed) run(api, key);
  }, [api, byKey, run]);

  const [facetState, setFacets] = useState<Facets>({ api: null, pages: {}, loading: false, error: null });
  const facets = facetState.api === api ? facetState : { api, pages: noPages, loading: false, error: null };
  const inFlight = useRef<{ api: BrowseApi; controller: AbortController } | null>(null);
  useEffect(() => () => {
    if (inFlight.current?.api === api) { inFlight.current.controller.abort(); inFlight.current = null; }
  }, [api]);
  const loadMore = useCallback((retry = false) => {
    // The ref guard makes repeated end-reached events in one frame a no-op instead of a restart.
    if (!api || inFlight.current || (facets.error && !retry)) return;
    const next = nextFacetPage(facets.pages);
    if (!next) return;
    const controller = new AbortController();
    inFlight.current = { api, controller };
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) setFacets((previous) => ({ ...(previous.api === api ? previous : { api, pages: {} }), loading: true, error: null }));
      return api.browseCategories(next.facet, next.offset, 24, controller.signal);
    }).then((page: BrowseCategoryPage) => {
      if (controller.signal.aborted || inFlight.current?.controller !== controller) return;
      inFlight.current = null;
      setFacets((previous) => {
        const pages = previous.api === api ? previous.pages : {};
        return { api, pages: acceptFacetPage(pages, page), loading: false, error: null };
      });
    }).catch((reason: unknown) => {
      if (controller.signal.aborted || inFlight.current?.controller !== controller) return;
      inFlight.current = null;
      setFacets((previous) => ({ ...(previous.api === api ? previous : { api, pages: {} }), loading: false,
        error: failure(reason, "Categories could not load.") }));
    });
  }, [api, facets.pages, facets.error]);
  const loaded = facetOrder.reduce((sum, facet) => sum + (facets.pages[facet]?.reduce((n, page) => n + page.items.length, 0) ?? 0), 0);
  useEffect(() => {
    // Keep filling until the first viewport has content or every facet is exhausted.
    if (loaded < fillTarget && !facets.loading && !facets.error) loadMore();
  }, [loaded, fillTarget, facets.loading, facets.error, loadMore]);

  return { states, retrySources, facets: facets.pages, facetsLoading: facets.loading || (!!api && !facets.error && loaded < fillTarget && nextFacetPage(facets.pages) !== null),
    facetsError: facets.error, facetsExhausted: nextFacetPage(facets.pages) === null, loadMore };
}
