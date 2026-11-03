import { optionalEnv, requireEnv } from "@mint/core/env";
import { httpJson, type RequestOpts } from "../http";
import { log } from "../log";

interface Field {
  name: string;
  value?: unknown;
}

interface Definition {
  id?: number;
  name: string;
  implementation: string;
  definitionName?: string;
  fields: Field[];
  indexerUrls?: string[];
  privacy?: string;
  capabilities?: { categories: Array<{ id: number }> };
  enable?: boolean;
  [key: string]: unknown;
}

export function api<T>(path: string, opts: RequestOpts = {}) {
  return httpJson<T>(`${requireEnv("PROWLARR_URL").replace(/\/$/, "")}/api/v1${path}`, {
    timeoutMs: 30_000,
    retries: 0,
    ...opts,
    headers: { "x-api-key": requireEnv("PROWLARR_API_KEY"), ...opts.headers },
  });
}

export const DEFAULT_INDEXERS = ["internetarchive", "thepiratebay", "limetorrents", "1337x"];
const valueOf = (definition: Definition, name: string) => definition.fields.find((field) => field.name === name)?.value;
const fieldsWith = (definition: Definition, values: Record<string, unknown>) =>
  definition.fields.map((field) => field.name in values ? { ...field, value: values[field.name] } : field);

let nextAttempt = 0;
let lastNotes: string[] = [];
let pendingSetup: Promise<string[]> | null = null;

export async function setupIndexers(): Promise<string[]> {
  if (!process.env.PROWLARR_URL || process.env.AUTO_CONFIGURE_INDEXERS === "false") return [];
  if (pendingSetup) return pendingSetup;
  if (Date.now() < nextAttempt) return lastNotes;
  pendingSetup = configureIndexers().finally(() => { pendingSetup = null; });
  return pendingSetup;
}

async function configureIndexers(): Promise<string[]> {
  const notes: string[] = [];
  try {
    const [schemas, existing, profiles, applications] = await Promise.all([
      api<Definition[]>("/indexer/schema"),
      api<Definition[]>("/indexer"),
      api<Array<{ id: number }>>("/appprofile"),
      api<Definition[]>("/applications"),
    ]);
    if (!profiles[0]) throw new Error("Prowlarr has no application sync profile");
    const selected = (process.env.PROWLARR_PUBLIC_INDEXERS ?? DEFAULT_INDEXERS.join(",")).split(",").map((id) => id.trim()).filter(Boolean);
    await Promise.all([...new Set(selected)].map(async (id) => {
      if (existing.some((indexer) => indexer.definitionName === id || valueOf(indexer, "definitionFile") === id)) return;
      const template = schemas.find((definition) => definition.definitionName === id);
      if (!template || template.privacy !== "public" || !template.capabilities?.categories.some((category) => category.id >= 3000 && category.id < 4000)) {
        notes.push(`Indexer ${id}: no public music-category definition in this Prowlarr version. Add account-based sources in Prowlarr yourself.`);
        return;
      }
      try {
        const values: Record<string, unknown> = {
          baseUrl: template.indexerUrls?.[0],
          "baseSettings.queryLimit": 100,
          "baseSettings.grabLimit": 100,
          "torrentBaseSettings.preferMagnetUrl": true,
        };
        if (id === "thepiratebay") values.top100 = 0;
        const definition = {
          ...template,
          name: `${template.name} (Mint)`,
          enable: true,
          appProfileId: profiles[0]!.id,
          fields: fieldsWith(template, values),
        };
        // Prowlarr validates the source before saving; never use forceSave to conceal a failure.
        await api("/indexer", { method: "POST", body: definition });
        log.info({ indexer: id }, "configured public indexer in Prowlarr");
      } catch {
        log.warn({ indexer: id }, "public indexer could not be configured; check Prowlarr events for the upstream error");
        notes.push(`Indexer ${id} could not pass Prowlarr validation. Check DNS, availability or access restrictions; Mint will retry in ten minutes.`);
      }
    }));

    const usenetUrl = process.env.USENET_INDEXER_URL?.trim();
    if (usenetUrl) {
      try {
        const url = new URL(usenetUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new Error("Usenet indexer URL must be a plain HTTP(S) base URL");
        }
        if (!existing.some((indexer) => indexer.implementation === "Newznab" && String(valueOf(indexer, "baseUrl")).replace(/\/$/, "") === usenetUrl.replace(/\/$/, ""))) {
          const schema = schemas.find((definition) => definition.implementation === "Newznab" && !valueOf(definition, "baseUrl"));
          if (!schema) throw new Error("Prowlarr has no generic Newznab definition");
          await api("/indexer", {
            method: "POST",
            body: {
              ...schema,
              name: "Usenet (Mint)",
              enable: true,
              appProfileId: profiles[0]!.id,
              fields: fieldsWith(schema, {
                baseUrl: usenetUrl,
                apiPath: optionalEnv("USENET_INDEXER_API_PATH", "/api"),
                apiKey: process.env.USENET_INDEXER_API_KEY ?? "",
              }),
            },
          });
          log.info("configured Newznab Usenet indexer");
        }
      } catch {
        log.warn("Usenet indexer setup failed; check the URL, API key and private Prowlarr events");
        notes.push("Usenet indexer could not pass Prowlarr validation. Check USENET_INDEXER_URL, its API key and the indexer's account/API limits.");
      }
    } else if (process.env.USENET_INDEXER_API_KEY) {
      notes.push("USENET_INDEXER_API_KEY is set but USENET_INDEXER_URL is missing.");
    }

    const lidarrUrl = requireEnv("LIDARR_URL").replace(/\/$/, "");
    const linked = applications.find((application) =>
      application.implementation === "Lidarr" && String(valueOf(application, "baseUrl")).replace(/\/$/, "") === lidarrUrl);
    if (!linked) {
      const appSchema = (await api<Definition[]>("/applications/schema")).find((definition) => definition.implementation === "Lidarr");
      if (!appSchema) throw new Error("Prowlarr does not provide a Lidarr integration");
      await api("/applications", {
        method: "POST",
        body: {
          ...appSchema,
          name: "Mint Lidarr",
          syncLevel: "addOnly",
          fields: fieldsWith(appSchema, {
            prowlarrUrl: optionalEnv("PROWLARR_URL", "http://prowlarr:9696"),
            baseUrl: lidarrUrl,
            apiKey: requireEnv("LIDARR_API_KEY"),
            syncCategories: [3000, 3010, 3040, 3050, 3060],
          }),
        },
      });
      log.info("linked Prowlarr to Lidarr (add-only; existing settings preserved)");
    } else {
      await api("/command", { method: "POST", body: { name: "ApplicationIndexerSync" } });
    }
    const current = await api<Definition[]>("/indexer");
    if (!current.some((indexer) => indexer.enable)) notes.push("Prowlarr has no enabled indexers yet. Check its events; automatic setup will retry.");
    if (!current.some((indexer) => indexer.enable && indexer.protocol === "usenet" && indexer.capabilities?.categories.some((category) => category.id >= 3000 && category.id < 4000))) {
      notes.push("TorBox Usenet is ready for NZBs, but needs a music-capable Newznab indexer. Set USENET_INDEXER_URL and its API key; TorBox Pro does not include that separate account.");
    }
    lastNotes = notes;
    nextAttempt = Date.now() + 10 * 60_000;
    return notes;
  } catch {
    // Prowlarr validation bodies can contain third-party credentials. Keep them out of public notes.
    log.warn("automatic indexer setup failed; check the private Prowlarr logs");
    lastNotes = ["Automatic indexer setup could not reach or configure Prowlarr. Check its container, API key and private logs; retrying in one minute."];
    nextAttempt = Date.now() + 60_000;
    return lastNotes;
  }

}
