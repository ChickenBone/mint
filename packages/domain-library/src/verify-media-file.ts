import { verifyLibraryAudio, type AudioProbeOptions, type LibraryAudioProbeResult } from "./audio-probe";
import path from "node:path";
import { LibraryFileAccessError, openLibraryMediaFileReadOnly, type PersistedLibraryRoot } from "./path-access";
import {
  LibraryRepositoryInputError, validateRecheckCandidatesInput,
  type LibraryRepository, type MediaVerificationOutcome,
} from "./repository";

type VerifiedObservation = Extract<LibraryAudioProbeResult, { status: "verified" }>;
type InconclusiveObservation = Extract<LibraryAudioProbeResult, { status: "unavailable" }>;
type UnavailableOutcome = Extract<MediaVerificationOutcome, { availability: "unavailable" }>;

export type LibraryMediaVerificationResult =
  | { status: "verified"; observation: VerifiedObservation; metadata: "imported" | "unavailable" }
  | { status: "unavailable"; outcome: UnavailableOutcome }
  | {
    status: "inconclusive";
    reason: InconclusiveObservation["reason"];
    verificationPersisted: boolean;
    observation?: InconclusiveObservation;
  };

export class LibraryMediaFileNotFoundError extends Error {
  constructor(readonly mediaFileId: string) {
    super("The persisted Library media file does not exist");
    this.name = "LibraryMediaFileNotFoundError";
  }
}

export class LibraryMediaMetadataWriteError extends Error {
  readonly verificationPersisted = true;

  constructor(
    readonly mediaFileId: string,
    readonly observation: VerifiedObservation,
    options: ErrorOptions,
  ) {
    super("Audio verification was persisted, but optional imported metadata could not be written", options);
    this.name = "LibraryMediaMetadataWriteError";
  }
}

export interface LibraryRecheckOptions {
  limit: number;
  after?: string;
  audio: Omit<AudioProbeOptions, "signal">;
  signal?: AbortSignal;
}

export interface LibraryRecheckResult {
  status: "completed" | "cancelled";
  results: { id: string; result: LibraryMediaVerificationResult }[];
  /** On cancellation, resume after the last completed ID, or the supplied `after`. */
  nextAfter: string | null;
}

/** Explicit trusted-worker operation; the configured root is not a client-supplied path. */
export async function recheckLibraryMediaFiles(
  repository: Pick<LibraryRepository, "getRecheckCandidates" | "getVerificationTarget" | "recordVerification" | "importVerifiedAudioTags">,
  configuredRoot: PersistedLibraryRoot,
  options: LibraryRecheckOptions,
): Promise<LibraryRecheckResult> {
  if (typeof configuredRoot.path !== "string" || !path.posix.isAbsolute(configuredRoot.path)
    || configuredRoot.path.includes("\0")) {
    throw new LibraryRepositoryInputError("Configured Library recheck root must have an absolute path without NUL");
  }
  const input = {
    rootId: configuredRoot.id, limit: options.limit, after: options.after,
  };
  validateRecheckCandidatesInput(input);
  const candidates = await repository.getRecheckCandidates(input);
  if (candidates.root.id.toLowerCase() !== configuredRoot.id.toLowerCase()
    || candidates.root.path !== configuredRoot.path) {
    throw new LibraryFileAccessError("ROOT_MISMATCH", "Configured Library recheck root does not match the persisted root");
  }
  const scopedRepository = {
    recordVerification: (id: string, outcome: MediaVerificationOutcome) => repository.recordVerification(id, outcome),
    importVerifiedAudioTags: (id: string, checkedAt: Date, tags: Parameters<LibraryRepository["importVerifiedAudioTags"]>[2]) =>
      repository.importVerifiedAudioTags(id, checkedAt, tags),
    async getVerificationTarget(id: string) {
      const target = await repository.getVerificationTarget(id);
      if (target && (target.root.id !== candidates.root.id || target.mediaFile.rootId !== candidates.root.id
        || target.root.path !== configuredRoot.path)) {
        throw new LibraryFileAccessError("ROOT_MISMATCH", "Library recheck target no longer belongs to the configured root");
      }
      return target;
    },
  };
  const results: LibraryRecheckResult["results"] = [];
  let after = options.after ?? null;
  for (const id of candidates.ids) {
    if (options.signal?.aborted) return { status: "cancelled", results, nextAfter: after };
    const result = await verifyLibraryMediaFile(scopedRepository, id, { ...options.audio, signal: options.signal });
    if (result.status === "inconclusive" && result.reason === "cancelled") {
      return { status: "cancelled", results: [...results, { id, result }], nextAfter: after };
    }
    results.push({ id, result });
    after = id;
  }
  if (options.signal?.aborted) return { status: "cancelled", results, nextAfter: after };
  return { status: "completed", results, nextAfter: candidates.nextAfter };
}

function fileFailure(error: unknown): "missing" | "unreadable" | undefined {
  if (!(error instanceof LibraryFileAccessError) || error.code !== "FILE_UNAVAILABLE") return;
  const cause = error.cause;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return;
  if (cause.code === "ENOENT") return "missing";
  if (cause.code === "EACCES" || cause.code === "EPERM") return "unreadable";
}

function cancelled(verificationPersisted = false): LibraryMediaVerificationResult {
  return { status: "inconclusive", reason: "cancelled", verificationPersisted };
}

/**
 * Trusted local-worker composition, not an HTTP path-input boundary or playback grant.
 * The repository supplies persisted paths; this call owns and closes the confined handle.
 */
export async function verifyLibraryMediaFile(
  repository: Pick<LibraryRepository, "getVerificationTarget" | "recordVerification" | "importVerifiedAudioTags">,
  mediaFileId: string,
  options: AudioProbeOptions,
): Promise<LibraryMediaVerificationResult> {
  const target = await repository.getVerificationTarget(mediaFileId);
  if (!target) throw new LibraryMediaFileNotFoundError(mediaFileId);
  if (options.signal?.aborted) return cancelled();

  let handle;
  try {
    handle = await openLibraryMediaFileReadOnly(target.root, target.mediaFile);
  } catch (error) {
    if (options.signal?.aborted) return cancelled();
    const reason = fileFailure(error);
    if (!reason) throw error;
    const outcome: UnavailableOutcome = { availability: "unavailable", checkedAt: new Date(), reason };
    await repository.recordVerification(mediaFileId, outcome);
    return options.signal?.aborted ? cancelled(true) : { status: "unavailable", outcome };
  }

  let observation: LibraryAudioProbeResult;
  try {
    observation = await verifyLibraryAudio(handle, options);
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Library audio verification failed and its handle could not be closed");
    }
    throw error;
  }
  await handle.close();

  if (options.signal?.aborted) return cancelled();
  if (observation.status === "unavailable") {
    return { status: "inconclusive", reason: observation.reason, verificationPersisted: false, observation };
  }
  if (observation.status === "not-audio") {
    const outcome: UnavailableOutcome = {
      availability: "unavailable", checkedAt: observation.checkedAt, reason: "invalid_audio",
    };
    await repository.recordVerification(mediaFileId, outcome);
    return options.signal?.aborted ? cancelled(true) : { status: "unavailable", outcome };
  }

  await repository.recordVerification(mediaFileId, {
    availability: "verified", checkedAt: observation.checkedAt, audio: observation.audio,
  });
  if (options.signal?.aborted) return cancelled(true);
  if (observation.probe.status === "available") {
    try {
      await repository.importVerifiedAudioTags(mediaFileId, observation.checkedAt, observation.tags);
    } catch (error) {
      throw new LibraryMediaMetadataWriteError(mediaFileId, observation, { cause: error });
    }
  }
  if (options.signal?.aborted) return cancelled(true);
  return {
    status: "verified", observation,
    metadata: observation.probe.status === "available" ? "imported" : "unavailable",
  };
}
