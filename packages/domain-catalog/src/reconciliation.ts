export type RecordingSource =
  | "omdb" | "apple" | "musicbrainz" | "youtube" | "ytmusic" | "spotify"
  | "deezer" | "audius" | "wikidata" | "soundcloud" | "openverse";

export interface RecordingReference {
  source: RecordingSource;
  identifier: string;
  country?: string;
}

export interface RecordingReconciliationQuery {
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number | null;
  references?: readonly RecordingReference[];
}

export interface RecordingObservation {
  key: string;
  source: RecordingSource;
  identifier: string;
  country: string;
  title: string;
  artist: string;
  album: string;
  url: string;
  observedAt: string | null;
  durationMs: number | null;
}

export interface RecordingAuthorityLink {
  authority: RecordingObservation;
  source: RecordingSource;
  identifier: string;
  url: string;
  observedAt: string | null;
  canonicalStatus: string;
}

export interface LinkedRecording {
  link: RecordingAuthorityLink;
  target: RecordingObservation;
}

/**
 * All methods are read-only and return at most `limit` rows in deterministic
 * order. Link queries must apply exclusion and authority filters before the
 * limit; search must use a bounded lexical index, not a full catalog scan.
 * A caller should supply a consistent read snapshot for the entire operation.
 */
export interface RecordingReconciliationReader {
  findByReference(reference: Required<RecordingReference>, limit: number): Promise<readonly RecordingObservation[]>;
  findAuthorityLinks(reference: Required<RecordingReference>, limit: number): Promise<readonly RecordingAuthorityLink[]>;
  findLinkedRecordings(authorityKeys: readonly string[], limit: number): Promise<readonly LinkedRecording[]>;
  search(title: string, artist: string, limit: number): Promise<readonly RecordingObservation[]>;
}

export type RecordingEvidence =
  | { code: "provider_id"; source: RecordingSource; identifier: string }
  | { code: "authority_link"; authority: RecordingSource; source: RecordingSource; identifier: string; url: string; observedAt: string | null }
  | { code: "title_exact" | "artist_exact" | "album_exact" }
  | { code: "duration_within_2s"; differenceMs: number };

export type RecordingConflict = "title_mismatch" | "artist_mismatch" | "version_mismatch" | "duration_mismatch";

export interface RecordingCandidate extends RecordingObservation {
  evidence: RecordingEvidence[];
  conflicts: RecordingConflict[];
  matchType: "explicit_identifier" | "metadata_candidate";
  rankScore: number;
  reviewRequired: boolean;
}

export interface RecordingReconciliationResult {
  version: "recording-reconciliation-v1";
  status: "identified" | "ambiguous" | "candidates" | "no_match";
  conflicts: ("multiple_authority_recordings" | "disconnected_references" | "candidate_window_truncated" | "metadata_conflict")[];
  reviewRequired: boolean;
  candidates: RecordingCandidate[];
  candidatesTruncated: boolean;
  automaticMerge: false;
  scoreNotice: string;
}

const WINDOW = 50;
const VERSION_WORDS = new Set(["live", "remix", "remastered", "remaster", "instrumental", "acoustic", "karaoke", "demo", "edit", "mono", "stereo", "sped", "slowed"]);
const IDENTIFIERS: Record<RecordingSource, RegExp> = {
  omdb: /^[a-zA-Z0-9_-]{1,128}$/,
  apple: /^[1-9][0-9]{0,19}$/,
  musicbrainz: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  youtube: /^[a-zA-Z0-9_-]{11}$/,
  ytmusic: /^[a-zA-Z0-9_-]{11}$/,
  spotify: /^[a-zA-Z0-9]{22}$/,
  deezer: /^[1-9][0-9]{0,19}$/,
  audius: /^[a-zA-Z0-9]{3,30}$/,
  wikidata: /^Q[1-9][0-9]{0,14}$/,
  soundcloud: /^[a-zA-Z0-9_-]{1,60}~[a-zA-Z0-9_-]{1,60}$/,
  openverse: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};

function reference(input: RecordingReference): Required<RecordingReference> {
  const country = input.country ?? "global";
  const identifier = input.source === "musicbrainz" ? input.identifier.toLowerCase() : input.identifier;
  if (!Object.hasOwn(IDENTIFIERS, input.source) || !IDENTIFIERS[input.source].test(identifier)
      || !/^(?:[a-z]{2}|global)$/.test(country)
      || (input.source === "apple" ? country === "global" : country !== "global")) {
    throw new TypeError("Invalid recording provider reference");
  }
  return { source: input.source, identifier, country };
}

function key(ref: Required<RecordingReference>): string {
  return `${ref.source}:${ref.country}:song:${ref.identifier}`;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ").normalize("NFKD")
    .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function observation(row: RecordingObservation): void {
  if (key(reference(row)) !== row.key) throw new Error("Invalid recording observation key");
}

function window<T>(rows: readonly T[]): readonly T[] {
  if (rows.length > WINDOW + 1) throw new Error("Reconciliation reader exceeded the requested limit");
  return rows;
}

function isAuthority(link: RecordingAuthorityLink): boolean {
  return (link.authority.source === "musicbrainz" || link.authority.source === "wikidata")
    && link.canonicalStatus !== "excluded" && link.canonicalStatus !== "conflict";
}

function assess(query: RecordingReconciliationQuery, row: RecordingObservation, explicit: RecordingEvidence[]): RecordingCandidate {
  const evidence = [...explicit];
  const conflicts: RecordingConflict[] = [];
  const title = normalize(query.title ?? "");
  const artist = normalize(query.artist ?? "");
  const candidateTitle = normalize(row.title);
  let rankScore = 0;
  if (title && title === candidateTitle) {
    evidence.push({ code: "title_exact" }); rankScore += 60;
  } else if (title) conflicts.push("title_mismatch");
  if (artist && artist === normalize(row.artist)) {
    evidence.push({ code: "artist_exact" }); rankScore += 30;
  } else if (artist) conflicts.push("artist_mismatch");
  if (query.album && normalize(query.album) === normalize(row.album)) {
    evidence.push({ code: "album_exact" }); rankScore += 5;
  }
  if (title) {
    const versions = (s: string) => [...new Set(s.split(" ").filter((word) => VERSION_WORDS.has(word)))].sort().join(" ");
    if (versions(title) !== versions(candidateTitle)) conflicts.push("version_mismatch");
  }
  if (query.durationMs != null && Number.isInteger(row.durationMs) && row.durationMs != null && row.durationMs > 0) {
    const differenceMs = Math.abs(query.durationMs - row.durationMs);
    if (differenceMs <= 2000) {
      evidence.push({ code: "duration_within_2s", differenceMs }); rankScore += 5;
    } else conflicts.push("duration_mismatch");
  }
  return {
    ...row, evidence, conflicts, rankScore,
    matchType: explicit.length ? "explicit_identifier" : "metadata_candidate",
    reviewRequired: conflicts.length > 0 || explicit.length === 0,
  };
}

/** Reconciliation returns evidence for review; it never creates or merges records. */
export async function reconcileRecordings(reader: RecordingReconciliationReader, query: RecordingReconciliationQuery): Promise<RecordingReconciliationResult> {
  const inputReferences = query.references ?? [];
  if (inputReferences.length > 5) throw new TypeError("Invalid recording reconciliation query");
  const references = inputReferences.map(reference);
  if ([query.title, query.artist, query.album].some((value) => value != null && (typeof value !== "string" || value.length > 500))
      || (query.durationMs != null && (!Number.isInteger(query.durationMs) || query.durationMs <= 0 || query.durationMs > 86400000))
      || (!references.length && !(normalize(query.title ?? "") && normalize(query.artist ?? "")))) {
    throw new TypeError("Invalid recording reconciliation query");
  }
  const rows = new Map<string, RecordingObservation>();
  const evidence = new Map<string, RecordingEvidence[]>();
  const sets: Set<string>[] = [];
  let explicitOverflow = false;
  let lexicalOverflow = false;
  const add = (row: RecordingObservation, item?: RecordingEvidence) => {
    observation(row);
    rows.set(row.key, row);
    if (item) evidence.set(row.key, [...(evidence.get(row.key) ?? []), item]);
  };
  for (const ref of references) {
    const found = new Set<string>();
    const variants = [ref];
    if (ref.source === "youtube" || ref.source === "ytmusic") {
      variants.push({ ...ref, source: ref.source === "youtube" ? "ytmusic" : "youtube" });
    }
    for (const variant of variants) {
      found.add(key(variant));
      const direct = window(await reader.findByReference(variant, WINDOW + 1));
      explicitOverflow ||= direct.length > WINDOW;
      for (const row of direct.slice(0, WINDOW)) {
        if (row.key !== key(variant)) throw new Error("Reference lookup returned an unrelated recording");
        add(row, { code: "provider_id", source: ref.source, identifier: ref.identifier });
      }
    }
    const links = window(await reader.findAuthorityLinks(ref, WINDOW + 1));
    explicitOverflow ||= links.length > WINDOW;
    for (const link of links.slice(0, WINDOW)) {
      if (!isAuthority(link)) continue;
      if (link.source !== ref.source || link.identifier !== ref.identifier) throw new Error("Authority lookup returned an unrelated link");
      add(link.authority, { code: "authority_link", authority: link.authority.source, source: ref.source, identifier: ref.identifier, url: link.url, observedAt: link.observedAt });
      found.add(link.authority.key);
    }
    const targets = window(await reader.findLinkedRecordings([...found], WINDOW + 1));
    explicitOverflow ||= targets.length > WINDOW;
    for (const { link, target } of targets.slice(0, WINDOW)) {
      if (!isAuthority(link)) continue;
      observation(link.authority);
      if (!found.has(link.authority.key) || target.source !== link.source || target.identifier !== link.identifier) {
        throw new Error("Authority lookup returned an unrelated target");
      }
      add(target, { code: "authority_link", authority: link.authority.source, source: link.source, identifier: link.identifier, url: link.url, observedAt: link.observedAt });
      found.add(target.key);
    }
    sets.push(found);
  }
  if (normalize(query.title ?? "") && normalize(query.artist ?? "")) {
    const lexical = window(await reader.search(query.title ?? "", query.artist ?? "", WINDOW + 1));
    lexicalOverflow = lexical.length > WINDOW;
    for (const row of lexical.slice(0, WINDOW)) add(row);
  }
  const candidates = [...rows.values()].map((row) => assess(query, row, evidence.get(row.key) ?? []));
  candidates.sort((a, b) => Number(a.matchType !== "explicit_identifier") - Number(b.matchType !== "explicit_identifier")
    || Number(a.conflicts.length > 0) - Number(b.conflicts.length > 0)
    || b.rankScore - a.rankScore || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const identified = candidates.filter((row) => row.matchType === "explicit_identifier");
  const authorities = new Map<RecordingSource, Set<string>>();
  for (const row of identified) {
    if (row.source === "musicbrainz" || row.source === "wikidata") {
      if (!authorities.has(row.source)) authorities.set(row.source, new Set());
      authorities.get(row.source)?.add(row.identifier);
    }
  }
  const conflicts: RecordingReconciliationResult["conflicts"] = [];
  if ([...authorities.values()].some((ids) => ids.size > 1)) conflicts.push("multiple_authority_recordings");
  if (sets.length > 1 && ![...(sets[0] ?? [])].some((k) => sets.every((set) => set.has(k)))) conflicts.push("disconnected_references");
  if (explicitOverflow && identified.length) conflicts.push("candidate_window_truncated");
  if (identified.some((row) => row.conflicts.length)) conflicts.push("metadata_conflict");
  const status = identified.length ? (conflicts.length ? "ambiguous" : "identified") : (candidates.length ? "candidates" : "no_match");
  return {
    version: "recording-reconciliation-v1", status, conflicts, reviewRequired: status !== "identified",
    candidates: candidates.slice(0, 10), candidatesTruncated: explicitOverflow || lexicalOverflow || candidates.length > 10,
    automaticMerge: false, scoreNotice: "rankScore orders metadata evidence; it is not a match probability",
  };
}
