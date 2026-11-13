export {
  LibraryFileAccessError,
  openLibraryMediaFileReadOnly,
  type LibraryFileAccessErrorCode,
  type PersistedLibraryRoot,
  type PersistedMediaFile,
  type ReadOnlyMediaFile,
  type ReadOnlyMediaFileWithMetadata,
} from "./path-access";
export { librarySchema, mediaFiles, roots } from "./schema";
export {
  createLibraryRepository,
  LibraryMediaWriteError,
  LibraryRepositoryInputError,
  LIBRARY_DEFAULT_PAGE_SIZE,
  LIBRARY_MAX_PAGE_SIZE,
  LIBRARY_MAX_SEARCH_LENGTH,
  type ImportedMediaTags,
  type LibraryFileListItem,
  type LibraryFilePage,
  type LibraryListInput,
  type LibraryRecheckCandidates,
  type LibraryRecheckCandidatesInput,
  type LibraryRepository,
  type LibraryVerificationTarget,
  type LibraryPlaybackTarget,
  type MediaVerificationOutcome,
} from "./repository";
export {
  AudioProbeConfigurationError,
  verifyLibraryAudio,
  type AudioProbeOptions,
  type ImportedAudioMetadata,
  type LibraryAudioProbeResult,
  type VerifiedAudioObservation,
} from "./audio-probe";
export {
  LibraryMediaFileNotFoundError,
  LibraryMediaMetadataWriteError,
  recheckLibraryMediaFiles,
  verifyLibraryMediaFile,
  type LibraryMediaVerificationResult,
  type LibraryRecheckOptions,
  type LibraryRecheckResult,
} from "./verify-media-file";
export {
  createLibraryScanRepository,
  LIBRARY_SCAN_AUDIO_EXTENSIONS,
  scanLibraryRoot,
  type LibraryScanOptions,
  type LibraryScanRepository,
  type LibraryScanResult,
} from "./scanner";
export {
  LIBRARY_MEDIA_READ_MAX_BYTES,
  LibraryMediaRangeError,
  LibraryPlaybackMediaError,
  openLibraryPlaybackMedia,
  parseLibraryMediaByteRange,
  type LibraryMediaByteRange,
  type LibraryPlaybackMedia,
  type LibraryPlaybackMediaErrorCode,
} from "./playback-media";
