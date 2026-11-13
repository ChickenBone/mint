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
  verifyLibraryMediaFile,
  type LibraryMediaVerificationResult,
} from "./verify-media-file";
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
