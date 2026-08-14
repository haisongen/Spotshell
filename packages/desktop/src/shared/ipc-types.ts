import type {
  FolderRemovalResult,
  HostFolder,
  HostProfile,
  HostProfileInput,
  HostTreeSnapshot,
  EnvironmentDeletePreview,
  EnvironmentDetail,
  EnvironmentExportMode,
  EnvironmentExportPreview,
  EnvironmentFormDraft,
  EnvironmentImportPreview,
  EnvironmentImportResolutions,
  EnvironmentImportResult,
  EnvironmentSummary,
  ExportedEnvironmentPackage,
  ExportedKnowledgeModulePackage,
  ExternalChangePreview,
  ExternalChangeStatus,
  KnowledgeModuleDetail,
  KnowledgeModuleFormDraft,
  KnowledgeModuleSummary,
  KnowledgeRevision,
  ManagedFileContent,
  ManagedObjectFilesDetail,
  ModuleDeletePreview,
  ModuleImportConflictResolution,
  ModuleImportPreview,
  ModuleImportResult,
  PermanentDeletePreview,
  RevisionCleanupPreview,
  RevisionCleanupResult,
  RevisionComparison,
  RevisionHistoryEntry,
  SeedModuleStatus,
  SeedRestorePreview,
  SeedRestoreResult,
  SourceUpdatePreview,
  SpaceRevision,
  ContextSlotId,
  GuidanceSourceLayer,
  TrashEntryDetail,
  TrashEntrySummary,
  TrashMoveResult,
  TrashPurgeResult,
  TrashRestoreResult,
} from '@spotshell/core'

export type {
  EnvironmentDeletePreview,
  ExternalChangePreview,
  ExternalChangeState,
  ExternalChangeStatus,
  ExternalFileChange,
  ExternalFileDiff,
  ManagedFileContent,
  ManagedObjectFileOrigin,
  ManagedObjectFileSummary,
  ManagedObjectFilesDetail,
  ModuleDeletePreview,
  PermanentDeletePreview,
  RevisionCleanupPreview,
  RevisionCleanupResult,
  RevisionComparison,
  RevisionFileDiff,
  RevisionHistoryEntry,
  RevisionProtectionReason,
  SeedModuleStatus,
  SeedRestorePreview,
  SeedRestoreResult,
  SourceUpdatePreview,
  TrashEntryDetail,
  TrashEntrySummary,
  TrashMoveResult,
  TrashPurgeResult,
  TrashRestoreResult,
} from '@spotshell/core'

export const IpcChannels = {
  hostsList: 'hosts:list',
  hostsAdd: 'hosts:add',
  hostsUpdate: 'hosts:update',
  hostsRemove: 'hosts:remove',
  hostsTest: 'hosts:test',
  hostsMove: 'hosts:move',
  hostsByEnvironment: 'hosts:byEnvironment',
  hostTreeGet: 'hostTree:get',
  hostFoldersAdd: 'hostFolders:add',
  hostFoldersRename: 'hostFolders:rename',
  hostFoldersRemove: 'hostFolders:remove',
  sessionConnect: 'session:connect',
  sessionReconnect: 'session:reconnect',
  sessionClose: 'session:close',
  sessionRename: 'session:rename',
  sessionDuplicate: 'session:duplicate',
  sessionCloseMany: 'session:closeMany',
  sessionList: 'session:list',
  sessionSelectEnvironment: 'session:selectEnvironment',
  sessionLoadKnowledge: 'session:loadKnowledge',
  sessionPinKnowledge: 'session:pinKnowledge',
  sessionUnpinKnowledge: 'session:unpinKnowledge',
  sessionUnloadKnowledge: 'session:unloadKnowledge',
  sessionApplyRevision: 'session:applyRevision',
  sessionKeepRevision: 'session:keepRevision',
  hostVerify: 'session:hostVerify',
  hostVerifyClosed: 'session:hostVerifyClosed',
  hostVerifyRespond: 'session:hostVerifyRespond',
  termInput: 'term:input',
  termResize: 'term:resize',
  termOutput: 'term:output',
  sessionStatus: 'session:status',
  agentChat: 'agent:chat',
  agentEvent: 'agent:event',
  agentClear: 'agent:clear',
  agentStartNewContext: 'agent:startNewContext',
  agentConfirm: 'agent:confirm',
  agentRespondNote: 'agent:respondNote',
  agentRespondKnowledgeTarget: 'agent:respondKnowledgeTarget',
  agentRespondKnowledgeProposal: 'agent:respondKnowledgeProposal',
  agentCancel: 'agent:cancel',
  sessionSetPolicy: 'session:setPolicy',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsTestLlm: 'settings:testLlm',
  dialogPassword: 'dialog:password',
  languageChanged: 'language:changed',
  clipboardReadText: 'clipboard:readText',
  clipboardWriteText: 'clipboard:writeText',
  appMenuPopup: 'appMenu:popup',
  knowledgeList: 'knowledge:list',
  knowledgeCreate: 'knowledge:create',
  knowledgeGet: 'knowledge:get',
  knowledgeSaveFormDraft: 'knowledge:saveFormDraft',
  knowledgeSaveSourceDraft: 'knowledge:saveSourceDraft',
  knowledgePublish: 'knowledge:publish',
  knowledgeSetGlobalOnDemand: 'knowledge:setGlobalOnDemand',
  environmentList: 'environment:list',
  environmentCreate: 'environment:create',
  environmentGet: 'environment:get',
  environmentSaveFormDraft: 'environment:saveFormDraft',
  environmentSaveSourceDraft: 'environment:saveSourceDraft',
  environmentPublish: 'environment:publish',
  managedFilesList: 'managedFiles:list',
  managedFilesCreate: 'managedFiles:create',
  managedFilesRead: 'managedFiles:read',
  managedFilesSave: 'managedFiles:save',
  managedFilesImport: 'managedFiles:import',
  managedFilesPickImport: 'managedFiles:pickImport',
  managedFilesPreviewSourceUpdate: 'managedFiles:previewSourceUpdate',
  managedFilesApplySourceUpdate: 'managedFiles:applySourceUpdate',
  managedFilesRename: 'managedFiles:rename',
  managedFilesRemove: 'managedFiles:remove',
  managedFilesSetGuidance: 'managedFiles:setGuidance',
  knowledgeOpenObjectRoot: 'knowledge:openObjectRoot',
  knowledgeScanExternalChanges: 'knowledge:scanExternalChanges',
  knowledgeScanAllExternalChanges: 'knowledge:scanAllExternalChanges',
  knowledgePreviewExternalChanges: 'knowledge:previewExternalChanges',
  knowledgeAdoptExternalChanges: 'knowledge:adoptExternalChanges',
  knowledgeDiscardExternalChanges: 'knowledge:discardExternalChanges',
  knowledgeExternalChangesEvent: 'knowledge:externalChangesEvent',
  knowledgeExportModule: 'knowledge:exportModule',
  knowledgeImportModulePreview: 'knowledge:importModulePreview',
  knowledgeImportModule: 'knowledge:importModule',
  knowledgePickExportModulePath: 'knowledge:pickExportModulePath',
  knowledgePickImportModulePath: 'knowledge:pickImportModulePath',
  knowledgeListRevisions: 'knowledge:listRevisions',
  knowledgeCompareRevisions: 'knowledge:compareRevisions',
  knowledgeRestoreRevision: 'knowledge:restoreRevision',
  knowledgePreviewRevisionCleanup: 'knowledge:previewRevisionCleanup',
  knowledgeCleanupRevisions: 'knowledge:cleanupRevisions',
  knowledgePreviewDelete: 'knowledge:previewDelete',
  knowledgeMoveToTrash: 'knowledge:moveToTrash',
  knowledgeListSeedModules: 'knowledge:listSeedModules',
  knowledgePreviewRestoreSeed: 'knowledge:previewRestoreSeed',
  knowledgeRestoreSeed: 'knowledge:restoreSeed',
  knowledgeRestoreAllSeeds: 'knowledge:restoreAllSeeds',
  environmentPreviewDelete: 'environment:previewDelete',
  environmentMoveToTrash: 'environment:moveToTrash',
  trashList: 'trash:list',
  trashGet: 'trash:get',
  trashRestore: 'trash:restore',
  trashPreviewPermanentDelete: 'trash:previewPermanentDelete',
  trashPermanentDelete: 'trash:permanentDelete',
  trashPurgeExpired: 'trash:purgeExpired',
  environmentExportPreview: 'environment:exportPreview',
  environmentExport: 'environment:export',
  environmentImportPreview: 'environment:importPreview',
  environmentImport: 'environment:import',
  environmentPickExportPath: 'environment:pickExportPath',
  environmentPickImportPath: 'environment:pickImportPath',
} as const

export type AppLanguage = 'en' | 'zh-CN'
export type AppTheme = 'dark' | 'light'
export type ModelProviderId = 'openai' | 'anthropic'
export type ModelProviderErrorKind =
  | 'authentication'
  | 'rate-limit'
  | 'model-not-found'
  | 'timeout'
  | 'network'
  | 'unsupported-tools'
  | 'unknown'
export type AppMenuId = 'file' | 'edit' | 'view' | 'window' | 'help'

export interface AppMenuPopupRequest {
  menuId: AppMenuId
  x: number
  y: number
}

export interface KnowledgeIdRequest {
  id: string
}

export interface KnowledgeCreateRequest {
  name: string
}

export interface KnowledgeRestoreSeedRequest {
  seedKey: string
  conflictResolution?: ModuleImportConflictResolution
  /** Defaults to true: grant global on-demand after a successful restore/create. */
  authorizeGlobalOnDemand?: boolean
}

export interface KnowledgeRestoreAllSeedsRequest {
  conflictResolution?: ModuleImportConflictResolution
  authorizeGlobalOnDemand?: boolean
}

export interface KnowledgeDraftFormRequest {
  id: string
  form: KnowledgeModuleFormDraft
}

export interface KnowledgeDraftSourceRequest {
  id: string
  source: string
}

export interface KnowledgeGlobalOnDemandRequest {
  id: string
  authorized: boolean
}

export interface ManagedFilesIdRequest {
  id: string
}

export interface ManagedFilesCreateRequest {
  id: string
  relativePath: string
  content?: string
}

export interface ManagedFilesPathRequest {
  id: string
  relativePath: string
}

export interface ManagedFilesSaveRequest {
  id: string
  relativePath: string
  content: string
}

export interface ManagedFilesImportRequest {
  id: string
  relativePath: string
  absoluteSourcePath: string
}

export interface ManagedFilesRenameRequest {
  id: string
  fromRelativePath: string
  toRelativePath: string
}

export interface ManagedFilesGuidanceRequest {
  id: string
  relativePath: string
  registered: boolean
}

export interface ManagedFilesPickImportResult {
  absoluteSourcePath: string
  suggestedRelativePath: string
}

export interface KnowledgeExportModuleRequest {
  id: string
  packagePath: string
}

export interface KnowledgeImportModulePreviewRequest {
  packagePath: string
}

export interface KnowledgeImportModuleRequest {
  packagePath: string
  conflictResolution?: ModuleImportConflictResolution
}

/** Optional live-session pins that protect revisions from cleanup. */
export interface KnowledgeRevisionProtectionRequest {
  agentActiveRevisions?: number[]
  proposalTargetRevisions?: number[]
  recoveryRequiredRevisions?: number[]
}

export interface KnowledgeListRevisionsRequest extends KnowledgeRevisionProtectionRequest {
  id: string
}

export interface KnowledgeCompareRevisionsRequest {
  id: string
  leftRevision: number
  rightRevision: number
}

export interface KnowledgeRestoreRevisionRequest {
  id: string
  revision: number
}

export interface KnowledgeRevisionCleanupRequest extends KnowledgeRevisionProtectionRequest {
  id: string
  revisions: number[]
}

export interface TrashPermanentDeleteRequest {
  id: string
  agentActiveRevisions?: number[]
}

export interface EnvironmentExportPreviewRequest {
  id: string
}

export interface EnvironmentExportRequest {
  id: string
  packagePath: string
  mode?: EnvironmentExportMode
}

export interface EnvironmentImportPreviewRequest {
  packagePath: string
}

export interface EnvironmentImportRequest {
  packagePath: string
  environmentResolution?: ModuleImportConflictResolution
  moduleResolutions?: Record<string, ModuleImportConflictResolution>
}

export type {
  EnvironmentExportMode,
  EnvironmentExportPreview,
  EnvironmentImportPreview,
  EnvironmentImportResolutions,
  EnvironmentImportResult,
  ExportedEnvironmentPackage,
  ExportedKnowledgeModulePackage,
  ModuleImportConflictResolution,
  ModuleImportPreview,
  ModuleImportResult,
}

export interface KnowledgeAssociationLocation {
  id: string
  name: string
}

export interface KnowledgeModuleAccessSummary extends KnowledgeModuleSummary {
  automaticCandidateEligible: boolean
  globalOnDemand: boolean
  environmentAlways: KnowledgeAssociationLocation[]
  environmentOnDemand: KnowledgeAssociationLocation[]
}

export interface EnvironmentCreateRequest {
  name: string
}

export interface EnvironmentDraftFormRequest {
  id: string
  form: EnvironmentFormDraft
}

export interface EnvironmentDraftSourceRequest {
  id: string
  source: string
}

export type {
  EnvironmentDetail,
  EnvironmentFormDraft,
  EnvironmentSummary,
  KnowledgeModuleDetail,
  KnowledgeModuleFormDraft,
  KnowledgeModuleSummary,
  KnowledgeRevision,
  SpaceRevision,
}

export interface ConnectRequest {
  hostId?: string
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  useAgent?: boolean
  title?: string
}

export interface SavedHostProfile extends HostProfile {
  hasPassword: boolean
}

export interface RenameSessionRequest {
  sessionId: string
  title: string
}

export interface DuplicateSessionRequest {
  sessionId: string
  title: string
}

export interface CloseSessionsRequest {
  sessionIds: string[]
}

export interface SessionEnvironmentSelectionRequest {
  sessionId: string
  environmentId?: string
  persistForHost: boolean
}

export interface SavedHostTreeSnapshot extends Omit<HostTreeSnapshot, 'hosts'> {
  hosts: SavedHostProfile[]
}

export interface AddHostFolderRequest {
  name: string
  parentId?: string
}

export interface RenameHostFolderRequest {
  id: string
  name: string
}

export interface RemoveHostFolderRequest {
  id: string
}

export interface MoveHostRequest {
  hostId: string
  folderId?: string
}

export type { FolderRemovalResult, HostFolder }

export interface SavedHostInput extends HostProfileInput {
  /** Empty clears a previously saved password; omitted leaves it unchanged. */
  password?: string
}

export interface HostConnectionTestResult {
  ok: boolean
  message: string
  latencyMs: number
}

export interface HostConnectionTestDraft {
  host: string
  port: number
  username: string
  authMethod: 'key' | 'password' | 'agent'
  privateKeyPath?: string
  password?: string
  useSavedPassword: boolean
}

export interface HostConnectionTestRequest {
  hostId: string
  draft?: HostConnectionTestDraft
}

/** Serializable Chat usage meter snapshot from ContextAssembler. */
export interface ContextUsageSlot {
  id: ContextSlotId
  estimatedTokens: number
  shareOfInputBudget: number
  estimated: true
}

export interface ContextUsageOmittedGuidance {
  id: string
  moduleName?: string
  sourceLayer: GuidanceSourceLayer
}

export interface ContextUsageConflict {
  leftId: string
  leftText: string
  leftModuleName?: string
  rightId: string
  rightText: string
  rightModuleName?: string
}

export interface ContextUsageSnapshot {
  contextWindowTokens: number
  outputReserveTokens: number
  safetyReserveTokens: number
  availableInputBudget: number
  usedInputTokens: number
  estimated: true
  slots: ContextUsageSlot[]
  omittedGuidance: ContextUsageOmittedGuidance[]
  conflictCount: number
  conflicts: ContextUsageConflict[]
  /** Provider-reported usage for display only; never rewrites estimates. */
  providerUsage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export type ContextBoundaryReason = 'user' | 'environment-switch'

export interface ContextBoundaryPayload {
  epoch: number
  previousEpoch: number
  createdAt: string
  reason: ContextBoundaryReason
  fromEnvironmentId?: string
  fromEnvironmentName?: string
  toEnvironmentId?: string
  toEnvironmentName?: string
}

/** One Agent-active knowledge object pin exposed to the Chat context bar. */
export interface SessionActiveRevision {
  objectId: string
  kind: 'environment' | 'knowledge' | 'host-notes'
  name: string
  revision: number
  contentHash: string
}

/** Saved revision newer than the Agent-active pin; never auto-applied. */
export interface SessionRevisionUpdateAvailable {
  objectId: string
  kind: 'environment' | 'knowledge' | 'host-notes'
  name: string
  activeRevision: number
  activeContentHash: string
  latestRevision: number
  latestContentHash: string
}

export interface SessionSummary {
  id: string
  title: string
  status: 'connecting' | 'ready' | 'disconnected' | 'error'
  hostId?: string
  environmentId?: string
  environmentSource: 'none' | 'host-binding' | 'session'
  pinnedModuleIds: string[]
  dynamicModuleIds: string[]
  /** Revisions the Agent is currently using for active objects. */
  activeRevisions: SessionActiveRevision[]
  /** Updates the user may apply from the next request (or keep current). */
  revisionUpdatesAvailable: SessionRevisionUpdateAvailable[]
  /** Backend Agent context segment id (independent of visible Chat transcript). */
  contextEpoch: number
  /** Whether the current epoch has Agent history / dynamic knowledge activity. */
  epochHasActivity: boolean
  /**
   * True while a user-terminal or agent SSH command is actively executing.
   * Blocks immediate new-context / environment-switch until the command ends.
   */
  commandRunning: boolean
  /**
   * Human-readable reason the new-context control is blocked, when applicable.
   * Empty/undefined means the control may proceed (cancelable work is settled first).
   */
  newContextBlockReason?: string
  errorKind?: ConnectionErrorKind
  errorMessage?: string
  policy: ExecPolicy
  contextUsage?: ContextUsageSnapshot
}

export interface SessionKnowledgeModuleRequest {
  sessionId: string
  moduleId: string
}

export interface SessionApplyRevisionRequest {
  sessionId: string
  objectId: string
  /** Exact target the user confirmed; stale if the object moved again. */
  targetRevision: number
  targetContentHash: string
}

export interface SessionKeepRevisionRequest {
  sessionId: string
  objectId: string
  /** Latest snapshot the user chose to ignore until it changes again. */
  latestRevision: number
  latestContentHash: string
}

export type ExecPolicy = 'readonly' | 'ask' | 'auto'

export interface ToolEndEventMeta {
  risk: 'readonly' | 'write' | 'destructive'
  decision: 'auto' | 'confirmed' | 'denied' | 'timeout'
  exitCode?: number | null
  durationMs?: number
  timedOut?: boolean
}

export interface HostVerifyRequest {
  requestId: string
  sessionId: string
  host: string
  port: number
  fingerprint: string
  /** undefined is first use; a value means the trusted fingerprint changed. */
  knownFingerprint?: string
}

export type ConnectionErrorKind =
  | 'network-timeout'
  | 'handshake-timeout'
  | 'connection-refused'
  | 'host-not-found'
  | 'authentication-failed'
  | 'host-key-rejected'
  | 'key-file-error'
  | 'connection-reset'
  | 'unknown'

export interface HostVerifyClosed {
  requestId: string
  sessionId: string
}

export type KnowledgeProposalTargetKind = 'host-notes' | 'environment' | 'knowledge'

export type KnowledgeProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'conflict'
  | 'validation-failed'

export interface KnowledgeProposalFileChangePayload {
  relativePath: string
  before: string
  after: string
}

export interface KnowledgeProposalSourcePayload {
  objectId: string
  objectName: string
  objectKind?: KnowledgeProposalTargetKind
  revision?: number
  contentHash?: string
  relativePath?: string
  startLine?: number
  endLine?: number
}

export interface KnowledgeChangeProposalPayload {
  id: string
  targetKind: KnowledgeProposalTargetKind
  targetId: string
  targetName: string
  baseRevision: number
  baseContentHash: string
  files: KnowledgeProposalFileChangePayload[]
  reason: string
  terminalEvidence: string
  knowledgeSources: KnowledgeProposalSourcePayload[]
  promoteToGuidance: boolean
  status: KnowledgeProposalStatus
  createdAt: string
  validationError?: string
  conflict?: {
    currentRevision: number
    currentContentHash: string
  }
}

export interface KnowledgeProposalRespondRequest {
  requestId: string
  ok: boolean
  reason?: string
  terminalEvidence?: string
  files?: KnowledgeProposalFileChangePayload[]
  promoteToGuidance?: boolean
}

export interface KnowledgeProposalResponseResult {
  accepted: boolean
  status?: 'approved' | 'rejected' | 'cancelled' | 'expired' | 'conflict' | 'validation-failed'
  message?: string
  proposal?: KnowledgeChangeProposalPayload
  unifiedDiff?: string
}

/** One landing place offered on a knowledge-target choice card. */
export interface KnowledgeTargetCandidatePayload {
  kind: 'host-notes' | 'environment' | 'knowledge'
  targetId: string
  label: string
  reason: string
}

export interface KnowledgeTargetRespondRequest {
  requestId: string
  /** Index into the offered candidates; null means "none of these". */
  optionIndex: number | null
}

export interface ApprovalResponseResult {
  accepted: boolean
  status?: 'approved' | 'rejected' | 'cancelled' | 'expired'
}

/** Frozen snapshot of an older-context message quoted into the current Agent turn. */
export interface AgentChatQuote {
  sourceMessageId: string
  sourceEpoch: number
  role: 'user' | 'assistant' | 'tool'
  createdAt: string
  contentSnapshot: string
  truncated?: boolean
  charRange?: { start: number; end: number }
}

export interface AgentChatRequest {
  sessionId: string
  message: string
  /** Explicit old-context quotes; never inferred from visible transcript alone. */
  quotes?: AgentChatQuote[]
}

/** System-generated knowledge provenance for one assistant answer. */
export interface KnowledgeProvenanceRecord {
  objectId: string
  objectName: string
  objectKind: 'environment' | 'knowledge'
  revision: number
  contentHash: string
  relativePath: string
  startLine: number
  endLine: number
  contentType: 'entry' | 'guidance' | 'reference' | 'metadata' | 'search-preview'
  loadReason: 'fixed' | 'environment-default' | 'dynamic' | 'search' | 'line-read' | 'entry-read'
}

/** Visible auto-load of a dynamic knowledge module inside the Agent tool loop. */
export interface KnowledgeModuleSelectedEvent {
  moduleId: string
  moduleName: string
  revision: number
  contentHash: string
  reason: string
  loadType: 'dynamic'
  scope?: 'environment' | 'session' | 'global'
}

/** Every Agent/knowledge/tool event carries the context epoch it belongs to. */
export type AgentEvent =
  | { type: 'status'; sessionId: string; epoch: number; text: string }
  | { type: 'token_delta'; sessionId: string; epoch: number; text: string }
  | { type: 'cancelled'; sessionId: string; epoch: number }
  | { type: 'tool_start'; sessionId: string; epoch: number; name: string; input: unknown }
  | {
      type: 'tool_end'
      sessionId: string
      epoch: number
      name: string
      output: string
      meta?: ToolEndEventMeta
    }
  | {
      type: 'final'
      sessionId: string
      epoch: number
      text: string
      provenance?: KnowledgeProvenanceRecord[]
    }
  | { type: 'context_usage'; sessionId: string; epoch: number; usage: ContextUsageSnapshot }
  | {
      type: 'knowledge_module_selected'
      sessionId: string
      epoch: number
      selection: KnowledgeModuleSelectedEvent
    }
  | {
      type: 'knowledge_revision_switch'
      sessionId: string
      epoch: number
      objectId: string
      kind: 'environment' | 'knowledge' | 'host-notes'
      name: string
      fromRevision: number
      fromContentHash: string
      toRevision: number
      toContentHash: string
      appliedAt: string
    }
  | {
      type: 'context_boundary'
      sessionId: string
      epoch: number
      previousEpoch: number
      createdAt: string
      reason: ContextBoundaryReason
      fromEnvironmentId?: string
      fromEnvironmentName?: string
      toEnvironmentId?: string
      toEnvironmentName?: string
    }
  | {
      type: 'context_compaction'
      sessionId: string
      epoch: number
      summary: ContextCompactionSummaryPayload
    }
  | {
      type: 'context_compaction_failed'
      sessionId: string
      epoch: number
      error: string
    }
  | {
      type: 'context_over_limit'
      sessionId: string
      epoch: number
      reason: ContextOverLimitReason
    }
  | { type: 'error'; sessionId: string; epoch: number; text: string }
  | {
      type: 'confirm_required'
      sessionId: string
      epoch: number
      command: string
      requestId: string
      risk: 'write' | 'destructive'
    }
  | { type: 'note_proposal'; sessionId: string; epoch: number; requestId: string; note: string }
  | {
      /** Agent is blocked until the user picks where a knowledge change lands. */
      type: 'knowledge_target_question'
      sessionId: string
      epoch: number
      requestId: string
      question: string
      candidates: readonly KnowledgeTargetCandidatePayload[]
    }
  | {
      type: 'knowledge_proposal'
      sessionId: string
      epoch: number
      requestId: string
      proposal: KnowledgeChangeProposalPayload
      unifiedDiff: string
    }
  | {
      type: 'approval_resolved'
      sessionId: string
      epoch: number
      requestId: string
      status: 'approved' | 'rejected' | 'cancelled' | 'expired'
    }

export interface PublicModelProviderSettings {
  model: string
  baseUrl?: string
  contextWindowTokens: number
  hasApiKey: boolean
}

export interface ModelSettings {
  activeProvider: ModelProviderId
  providers: Record<ModelProviderId, PublicModelProviderSettings>
}

export interface ModelProviderSettingsPatch {
  provider: ModelProviderId
  model?: string
  baseUrl?: string
  contextWindowTokens?: number | null
  apiKey?: string
}

export interface SettingsPatch {
  language?: AppLanguage
  theme?: AppTheme
  shellIntegration?: boolean
  recursionLimit?: number
  allowAutoContextCompaction?: boolean
  model?: {
    activeProvider?: ModelProviderId
    provider?: ModelProviderSettingsPatch
  }
}

export interface AppSettings {
  language: AppLanguage
  theme: AppTheme
  shellIntegration: boolean
  model: ModelSettings
  recursionLimit?: number
  /**
   * When true (default), older chat/tool output may be summarized once near the
   * context limit. When false, only an over-limit hint is shown.
   */
  allowAutoContextCompaction: boolean
}

/** Inspectable one-shot compaction summary carried on Agent events. */
export interface ContextCompactionSummaryPayload {
  id: string
  text: string
  coveredMessageIds: string[]
  coveredFromPreview: string
  coveredToPreview: string
  model: string
  createdAt: string
  estimatedTokens: number
}

export type ContextOverLimitReason =
  | 'auto_compact_disabled'
  | 'summary_budget_exhausted'
  | 'nothing_eligible'

/** Draft values from Settings form; empty apiKey falls back to saved key */
export interface LlmTestRequest {
  provider: ModelProviderId
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface LlmTestResult {
  ok: boolean
  provider: ModelProviderId
  message: string
  model?: string
  latencyMs?: number
  statusCode?: number
  errorKind?: ModelProviderErrorKind
}
