export { logger, LogLevel } from './utils/logger.js';
export { SSHClient } from './ssh/SSHClient.js';
export type {
  SSHConnectionConfig,
  SSHClientEvents,
  CommandResult,
  HostKeyInfo,
} from './ssh/types.js';
export { toSSH2Config } from './ssh/types.js';
export { hostKeyFingerprint } from './ssh/fingerprint.js';
export { ContextBuffer } from './context/ContextBuffer.js';
export type { ContextBufferOptions } from './context/ContextBuffer.js';
export { OscParser } from './context/OscParser.js';
export type { ShellIntegrationEvent } from './context/OscParser.js';
export { ShellIntegration, SHELL_INTEGRATION_SNIPPET } from './context/ShellIntegration.js';
export { SpotShellAgent, AgentCancelledError } from './agent/SpotShellAgent.js';
export {
  MODEL_PROVIDER_IDS,
  getModelProvider,
  isModelProviderId,
  parseModelProviderId,
} from './agent/providers/registry.js';
export type {
  ModelProvider,
  ModelProviderConfig,
  ModelProviderErrorInfo,
  ModelProviderErrorKind,
  ModelProviderId,
} from './agent/providers/types.js';
export type {
  SpotShellAgentDependencies,
  ContextCompactionSummarizer,
} from './agent/SpotShellAgent.js';
export { buildSystemPrompt, buildContextMessage } from './agent/prompt.js';
export { SSHCommandExecutor } from './agent/SSHCommandExecutor.js';
export { createSSHTools, shellQuoteArg } from './agent/tools.js';
export type {
  KnowledgeChangeProposalRequest,
  KnowledgeTargetCandidate,
  KnowledgeTargetQuestion,
  SSHToolExtras,
} from './agent/tools.js';
export { formatCommandResult } from './agent/format.js';
export { isDangerousCommand } from './agent/danger.js';
export { parseCommandLine } from './agent/commandParse.js';
export type { ParsedCommandLine, CommandSegment } from './agent/commandParse.js';
export { classifyCommand } from './agent/risk.js';
export { estimateTokens, trimHistoryToBudget, capToolMessage } from './agent/history.js';
export {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  DEFAULT_CONTEXT_WINDOW,
  listKnownModelContextWindows,
  lookupKnownModelContextWindow,
  normalizeContextWindow,
  resolveContextWindow,
} from './agent/modelContext.js';
export type {
  AgentConfig,
  AgentContext,
  SSHExecutor,
  RiskLevel,
  ExecPolicy,
  AgentStreamEvent,
  ChatStreamOptions,
  AgentLanguage,
  AgentHistory,
  AgentRuntime,
} from './agent/types.js';
export {
  assembleModelContext,
  attachProviderUsage,
  detectObviousConflicts,
  estimateTextTokens,
  sortGuidance,
  computeOutputReserveTokens,
  computeSafetyReserveTokens,
} from './context/ContextAssembler.js';
export type {
  AssembledContextContent,
  ContextAssemblerInput,
  ContextAssemblyResult,
  ContextSlotId,
  ContextSlotUsage,
  GuidanceConflict,
  GuidanceRule,
  GuidanceSourceLayer,
  ProviderTokenUsage,
} from './context/ContextAssembler.js';
export {
  COMPACTION_SUMMARY_BUDGET_RATIO,
  COMPACTION_TRIGGER_RATIO,
  buildCompactionSummaryRecord,
  ensureMessageIds,
  estimateMessagesTokens,
  formatCompactionSummariesForContext,
  isEligibleForCompaction,
  isOverCompactionTrigger,
  planContextCompaction,
  remainingSummaryBudgetTokens,
  splitEligibleCompactionWindow,
} from './context/ContextCompaction.js';
export type {
  CompactionOverLimitReason,
  CompactionPlan,
  CompactionSummaryRecord,
  PlanContextCompactionInput,
} from './context/ContextCompaction.js';
export { buildKnowledgeAssemblyParts } from './context/knowledgeAssembly.js';
export type { KnowledgeAssemblyParts } from './context/knowledgeAssembly.js';
export { HostStore, MAX_HOST_FOLDER_NAME_LENGTH } from './hosts/HostStore.js';
export type {
  FolderRemovalResult,
  HostFolder,
  HostFolderInput,
  HostProfile,
  HostProfileInput,
  HostTreeSnapshot,
} from './hosts/types.js';
export {
  SPACE_SCHEMA_VERSION,
  SPACE_V1_LIMITS,
} from './knowledge/limits.js';
export {
  SafeObjectRoot,
  ObjectRootError,
  assertManagedTextPath,
  decodeManagedTextBytes,
  isGuidanceEligiblePath,
  normalizeRelativePath,
} from './knowledge/safeObjectRoot.js';
export type { ManagedTextFile } from './knowledge/safeObjectRoot.js';
export {
  assertUniqueSpaceIds,
  extractInlineGuidance,
  parseSpaceDocument,
  repairMissingSpaceFrontmatter,
  serializeSpaceDocument,
  spaceDocumentFromForm,
  SpaceDocumentError,
  toSpaceForm,
} from './knowledge/spaceDocument.js';
export type {
  EnvironmentSpaceMetadata,
  KnowledgeSpaceMetadata,
  SpaceDocument,
  SpaceForm,
  SpaceMetadata,
} from './knowledge/spaceDocument.js';
export { loadSpaceObject } from './knowledge/spaceObject.js';
export type { LoadedSpaceObject } from './knowledge/spaceObject.js';
export { scanKnowledgeSecrets } from './knowledge/secretScanner.js';
export type {
  SecretDisposition,
  SecretFinding,
  SecretScanResult,
} from './knowledge/secretScanner.js';
export { KnowledgeRepository } from './knowledge/knowledgeRepository.js';
export type {
  CreateEnvironmentDraftInput,
  CreateKnowledgeDraftInput,
  CreateManagedTextFileInput,
  DeleteBlocker,
  DeleteBlockerCode,
  EnvironmentDeletePreview,
  EnvironmentDetail,
  EnvironmentExportMode,
  EnvironmentExportModulePreview,
  EnvironmentExportPreview,
  EnvironmentFormDraft,
  EnvironmentHostBinding,
  EnvironmentImportObjectSnapshot,
  EnvironmentImportObjectStatus,
  EnvironmentImportModulePreview,
  EnvironmentImportPreview,
  EnvironmentImportResolutions,
  EnvironmentImportResult,
  EnvironmentModuleDependency,
  EnvironmentSummary,
  ExportedEnvironmentPackage,
  ExportedKnowledgeModulePackage,
  ExternalChangePreview,
  ExternalChangeState,
  ExternalChangeStatus,
  ImportManagedTextFileInput,
  KnowledgeModuleDetail,
  KnowledgeModuleFormDraft,
  KnowledgeModuleSummary,
  KnowledgeRepositoryOptions,
  KnowledgeRevision,
  ManagedFileContent,
  ManagedObjectFileOrigin,
  ManagedObjectFileSummary,
  ManagedObjectFilesDetail,
  ModuleDeletePreview,
  ModuleImportConflictResolution,
  ModuleImportIncomingSnapshot,
  ModuleImportLocalSnapshot,
  ModuleImportPreview,
  ModuleImportResult,
  ModuleReferenceByEnvironment,
  PermanentDeletePreview,
  PublishedEnvironmentSummary,
  PublishedKnowledgeModuleSummary,
  PublishedObjectRoot,
  RestoreAssociationResult,
  RestoreAssociationStatus,
  RevisionCleanupPreview,
  RevisionCleanupResult,
  RevisionComparison,
  RevisionFileDiff,
  RevisionFileSnapshot,
  RevisionHistoryEntry,
  RevisionProtectionInput,
  RevisionProtectionReason,
  SourceUpdatePreview,
  SpaceRevision,
  TrashEntryDetail,
  TrashEntrySummary,
  TrashMoveResult,
  TrashObjectKind,
  TrashPurgeResult,
  TrashRecord,
  TrashReferenceSnapshot,
  TrashRepairResult,
  TrashRestoreResult,
} from './knowledge/knowledgeRepository.js';
export {
  detectExternalContentDiff,
  EXTERNAL_EDIT_DEBOUNCE_MS,
  externalOrigin,
  filterWorkingContentPaths,
  isEditorTemporaryPath,
  shouldIgnoreExternalWatchEvent,
  workingTreeFingerprint,
} from './knowledge/externalEdits.js';
export type {
  ExternalContentDiff,
  ExternalFileChange,
  ExternalFileDiff,
} from './knowledge/externalEdits.js';
export {
  DEFAULT_TRASH_RETENTION_DAYS,
  computeExpiresAt,
  daysRemaining,
  isExpired,
} from './knowledge/knowledgeRepository.js';
export {
  annotateRevisionHistoryEntry,
  assertCleanupAllowed,
  assertEnoughDiskSpace,
  buildRevisionComparison,
  compareRevisionFiles,
  DEFAULT_MIN_FREE_DISK_BYTES,
  exclusiveBytesForRevision,
  isRevisionProtected,
  normalizeRevisionOrigin,
  planRevisionCleanup,
  protectionReasonsForRevision,
  publishOrigin,
  restoreOrigin,
} from './knowledge/revisionHistory.js';
export {
  ModulePackageError,
  MODULE_PACKAGE_FORMAT_VERSION,
  MODULE_PACKAGE_KIND,
} from './knowledge/modulePackage.js';
export type {
  BuiltKnowledgeModulePackage,
  KnowledgeModulePackage,
  KnowledgeModulePackageFile,
} from './knowledge/modulePackage.js';
export {
  HEALTH_CHECK_COMMANDS,
  OFFICIAL_SEED_MODULES,
  buildOfficialSeedPackage,
  getOfficialSeedById,
  getOfficialSeedByKey,
  isOfficialSeedId,
  officialSeedDocument,
  serializeOfficialSeedPackage,
} from './knowledge/seedModules.js';
export type {
  OfficialSeedKey,
  OfficialSeedModuleDefinition,
} from './knowledge/seedModules.js';
export {
  SEED_MIGRATION_MARKER_FILE,
  SEED_MIGRATION_MARKER_VERSION,
  ensureOfficialSeedModules,
  listOfficialSeedStatuses,
  previewRestoreOfficialSeed,
  readSeedMigrationMarker,
  restoreAllOfficialSeeds,
  restoreOfficialSeed,
  seedMigrationMarkerPath,
} from './knowledge/seedMigration.js';
export type {
  SeedEnsureAction,
  SeedEnsureResult,
  SeedMigrationMarker,
  SeedModulePresence,
  SeedModuleStatus,
  SeedRestorePreview,
  SeedRestoreResult,
} from './knowledge/seedMigration.js';
export {
  EnvironmentPackageError,
  ENVIRONMENT_PACKAGE_FORMAT_VERSION,
  ENVIRONMENT_BUNDLE_KIND,
  ENVIRONMENT_DEFINITION_KIND,
} from './knowledge/environmentPackage.js';
export type {
  BuiltEnvironmentObject,
  BuiltEnvironmentPackage,
  EnvironmentPackage,
  EnvironmentPackageFile,
  EnvironmentPackageKind,
  PackagedObjectPayload,
} from './knowledge/environmentPackage.js';
export {
  applyPendingRevision,
  createPendingRevisionApply,
  detectRevisionUpdates,
  dismissRevisionUpdate,
  ensureActivePin,
  formatVersionSwitchContextEvent,
  hostNotesObjectId,
  isHostNotesObjectId,
  dismissedUpdateKey,
} from './knowledge/activeRevisions.js';
export type {
  ActiveObjectKind,
  ActiveRevisionPin,
  ApplyPendingRevisionResult,
  LatestRevisionSnapshot,
  PendingRevisionApply,
  RevisionUpdateAvailable,
  VersionSwitchEvent,
} from './knowledge/activeRevisions.js';
export {
  queryKnowledgeCatalog,
  resolveKnowledgeCatalog,
} from './knowledge/knowledgeCatalog.js';
export type {
  KnowledgeCatalogEntry,
  KnowledgeCatalogOptions,
  KnowledgeCatalogQuery,
  KnowledgeCatalogQueryResult,
  KnowledgeCatalogScope,
  KnowledgeCatalogSources,
  ResolvedKnowledgeCatalog,
} from './knowledge/knowledgeCatalog.js';
export {
  KnowledgeHarness,
  KnowledgeHarnessError,
} from './knowledge/knowledgeHarness.js';
export type {
  DynamicModuleSelection,
  KnowledgeFileListResult,
  KnowledgeHarnessConfig,
  KnowledgeLineReadOptions,
  KnowledgeModuleSelectResult,
  KnowledgeObjectAccess,
  KnowledgeObjectHandle,
  KnowledgeReadResult,
  KnowledgeSearchMatch,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
} from './knowledge/knowledgeHarness.js';
export { loadReasonForAccess } from './knowledge/provenance.js';
export type {
  KnowledgeContentType,
  KnowledgeLoadReason,
  KnowledgeProvenanceRecord,
} from './knowledge/provenance.js';
export { createKnowledgeTools } from './agent/knowledgeTools.js';
export type { KnowledgeToolAccess } from './agent/knowledgeTools.js';
export {
  buildProposalUnifiedDiff,
  cancelKnowledgeProposal,
  checkProposalBase,
  createKnowledgeProposal,
  editKnowledgeProposal,
  prepareAcceptKnowledgeProposal,
  proposalChangesGuidance,
  proposedFileContents,
  rebaseKnowledgeProposal,
  rejectKnowledgeProposal,
} from './knowledge/knowledgeProposal.js';
export type {
  CreateKnowledgeProposalInput,
  CreateKnowledgeProposalResult,
  EditKnowledgeProposalResult,
  KnowledgeChangeProposal,
  KnowledgeProposalConflict,
  KnowledgeProposalFileChange,
  KnowledgeProposalSource,
  KnowledgeProposalStatus,
  KnowledgeProposalTargetKind,
  PrepareAcceptKnowledgeProposalResult,
  ProposalBaseSnapshot,
} from './knowledge/knowledgeProposal.js';
export { proposalOrigin } from './knowledge/revisionHistory.js';
