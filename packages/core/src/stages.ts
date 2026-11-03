export const STAGES = [
  "queued",
  "matching",
  "searching",
  "downloading",
  "importing",
  "tagging",
  "scanning",
  "previewing",
  "analyzing",
  "ready",
  "failed",
] as const;

export type Stage = (typeof STAGES)[number];

export const ACTIVE_STAGES = STAGES.filter((s) => s !== "ready" && s !== "failed");

export const STAGE_LABEL: Record<Stage, string> = {
  queued: "Queued",
  matching: "Matching",
  searching: "Searching",
  downloading: "Downloading",
  importing: "Importing",
  tagging: "Tagging",
  scanning: "Plex scan",
  previewing: "Preview",
  analyzing: "Sonic analysis",
  ready: "Ready",
  failed: "Failed",
};

/** Columns shown on the public pipeline board; several internal stages collapse into one lane. */
export const PIPELINE_LANES = [
  { id: "match", label: "Matching", stages: ["queued", "matching", "searching"] },
  { id: "download", label: "Downloading", stages: ["downloading"] },
  { id: "import", label: "Importing", stages: ["importing", "tagging"] },
  { id: "scan", label: "Plex scan", stages: ["scanning", "previewing"] },
  { id: "sonic", label: "Sonic analysis", stages: ["analyzing"] },
] as const satisfies ReadonlyArray<{ id: string; label: string; stages: readonly Stage[] }>;

export const SOURCES = ["lidarr", "cobalt"] as const;
export type Source = (typeof SOURCES)[number];
