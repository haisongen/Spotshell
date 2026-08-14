export const SPACE_SCHEMA_VERSION = 1 as const;

export const SPACE_V1_LIMITS = Object.freeze({
  maxFilesPerObject: 256,
  maxDirectoriesPerObject: 64,
  maxDirectoryDepth: 8,
  maxFileBytes: 2 * 1024 * 1024,
  maxObjectBytes: 16 * 1024 * 1024,
  maxGuidanceFiles: 16,
  maxRelativePathChars: 240,
  maxRegexPatternChars: 256,
  maxRegexExecutionMs: 50,
  maxSearchMatches: 100,
  maxSearchPreviewChars: 500,
  maxReadLines: 200,
  maxReadBytes: 64 * 1024,
});
