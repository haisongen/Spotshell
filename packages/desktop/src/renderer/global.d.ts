import type {
  AgentChatRequest,
  AgentEvent,
  ApprovalResponseResult,
  AddHostFolderRequest,
  AppMenuPopupRequest,
  AppSettings,
  SettingsPatch,
  ConnectRequest,
  RenameSessionRequest,
  DuplicateSessionRequest,
  CloseSessionsRequest,
  SessionEnvironmentSelectionRequest,
  SessionKnowledgeModuleRequest,
  SessionApplyRevisionRequest,
  SessionKeepRevisionRequest,
  ExecPolicy,
  HostConnectionTestResult,
  HostConnectionTestRequest,
  HostFolder,
  HostVerifyRequest,
  HostVerifyClosed,
  LlmTestRequest,
  LlmTestResult,
  EnvironmentCreateRequest,
  EnvironmentDetail,
  EnvironmentDraftFormRequest,
  EnvironmentDraftSourceRequest,
  EnvironmentExportMode,
  EnvironmentExportPreview,
  EnvironmentExportPreviewRequest,
  EnvironmentExportRequest,
  EnvironmentImportPreview,
  EnvironmentImportPreviewRequest,
  EnvironmentImportRequest,
  EnvironmentImportResult,
  EnvironmentSummary,
  KnowledgeCompareRevisionsRequest,
  KnowledgeCreateRequest,
  KnowledgeDraftFormRequest,
  KnowledgeDraftSourceRequest,
  KnowledgeExportModuleRequest,
  KnowledgeImportModulePreviewRequest,
  KnowledgeImportModuleRequest,
  KnowledgeListRevisionsRequest,
  KnowledgeModuleDetail,
  KnowledgeGlobalOnDemandRequest,
  KnowledgeModuleAccessSummary,
  KnowledgeRestoreRevisionRequest,
  KnowledgeRevisionCleanupRequest,
  KnowledgeRevision,
  EnvironmentDeletePreview,
  ExportedEnvironmentPackage,
  ExportedKnowledgeModulePackage,
  ModuleDeletePreview,
  ModuleImportConflictResolution,
  ModuleImportPreview,
  ModuleImportResult,
  PermanentDeletePreview,
  RevisionCleanupPreview,
  RevisionCleanupResult,
  RevisionComparison,
  RevisionHistoryEntry,
  TrashEntryDetail,
  TrashEntrySummary,
  TrashMoveResult,
  TrashPermanentDeleteRequest,
  TrashPurgeResult,
  TrashRestoreResult,
  ExternalChangePreview,
  ExternalChangeStatus,
  ManagedFileContent,
  ManagedFilesCreateRequest,
  ManagedFilesGuidanceRequest,
  ManagedFilesImportRequest,
  ManagedFilesPathRequest,
  ManagedFilesPickImportResult,
  ManagedFilesRenameRequest,
  ManagedFilesSaveRequest,
  ManagedObjectFilesDetail,
  SourceUpdatePreview,
  SpaceRevision,
  MoveHostRequest,
  FolderRemovalResult,
  RemoveHostFolderRequest,
  RenameHostFolderRequest,
  SavedHostInput,
  SavedHostProfile,
  SavedHostTreeSnapshot,
  SessionSummary,
} from '../shared/ipc-types'

export interface TermOutputPayload {
  sessionId: string
  data: string
}

export interface SpotShellApi {
  listEnvironments: () => Promise<EnvironmentSummary[]>
  createEnvironment: (request: EnvironmentCreateRequest) => Promise<EnvironmentDetail>
  getEnvironment: (id: string) => Promise<EnvironmentDetail>
  saveEnvironmentFormDraft: (request: EnvironmentDraftFormRequest) => Promise<EnvironmentDetail>
  saveEnvironmentSourceDraft: (request: EnvironmentDraftSourceRequest) => Promise<EnvironmentDetail>
  publishEnvironmentDraft: (id: string) => Promise<SpaceRevision>
  previewEnvironmentExport: (
    request: EnvironmentExportPreviewRequest,
  ) => Promise<EnvironmentExportPreview>
  exportEnvironment: (
    request: EnvironmentExportRequest,
  ) => Promise<ExportedEnvironmentPackage>
  previewEnvironmentImport: (
    request: EnvironmentImportPreviewRequest,
  ) => Promise<EnvironmentImportPreview>
  importEnvironment: (
    request: EnvironmentImportRequest,
  ) => Promise<EnvironmentImportResult>
  pickEnvironmentExportPath: (suggestedName: string) => Promise<string | null>
  pickEnvironmentImportPath: () => Promise<string | null>
  listKnowledgeModules: () => Promise<KnowledgeModuleAccessSummary[]>
  createKnowledgeModule: (request: KnowledgeCreateRequest) => Promise<KnowledgeModuleDetail>
  getKnowledgeModule: (id: string) => Promise<KnowledgeModuleDetail>
  saveKnowledgeFormDraft: (request: KnowledgeDraftFormRequest) => Promise<KnowledgeModuleDetail>
  saveKnowledgeSourceDraft: (request: KnowledgeDraftSourceRequest) => Promise<KnowledgeModuleDetail>
  publishKnowledgeDraft: (id: string) => Promise<KnowledgeRevision>
  listKnowledgeRevisions: (
    request: KnowledgeListRevisionsRequest,
  ) => Promise<RevisionHistoryEntry[]>
  compareKnowledgeRevisions: (
    request: KnowledgeCompareRevisionsRequest,
  ) => Promise<RevisionComparison>
  restoreKnowledgeRevision: (
    request: KnowledgeRestoreRevisionRequest,
  ) => Promise<KnowledgeRevision>
  previewKnowledgeRevisionCleanup: (
    request: KnowledgeRevisionCleanupRequest,
  ) => Promise<RevisionCleanupPreview>
  cleanupKnowledgeRevisions: (
    request: KnowledgeRevisionCleanupRequest,
  ) => Promise<RevisionCleanupResult>
  previewDeleteKnowledgeModule: (id: string) => Promise<ModuleDeletePreview>
  moveKnowledgeModuleToTrash: (id: string) => Promise<TrashMoveResult>
  previewDeleteEnvironment: (id: string) => Promise<EnvironmentDeletePreview>
  moveEnvironmentToTrash: (id: string) => Promise<TrashMoveResult>
  listTrash: () => Promise<TrashEntrySummary[]>
  getTrashEntry: (id: string) => Promise<TrashEntryDetail>
  restoreFromTrash: (id: string) => Promise<TrashRestoreResult>
  previewPermanentDelete: (
    request: TrashPermanentDeleteRequest,
  ) => Promise<PermanentDeletePreview>
  permanentlyDeleteFromTrash: (request: TrashPermanentDeleteRequest) => Promise<void>
  purgeExpiredTrash: () => Promise<TrashPurgeResult>
  setKnowledgeGlobalOnDemand: (request: KnowledgeGlobalOnDemandRequest) => Promise<void>
  listSeedModules: () => Promise<import('../shared/ipc-types').SeedModuleStatus[]>
  previewRestoreSeedModule: (
    seedKey: string,
  ) => Promise<import('../shared/ipc-types').SeedRestorePreview>
  restoreSeedModule: (
    request: import('../shared/ipc-types').KnowledgeRestoreSeedRequest,
  ) => Promise<import('../shared/ipc-types').SeedRestoreResult>
  restoreAllSeedModules: (
    request?: import('../shared/ipc-types').KnowledgeRestoreAllSeedsRequest,
  ) => Promise<import('../shared/ipc-types').SeedRestoreResult[]>
  exportKnowledgeModule: (
    request: KnowledgeExportModuleRequest,
  ) => Promise<ExportedKnowledgeModulePackage>
  previewKnowledgeModuleImport: (
    request: KnowledgeImportModulePreviewRequest,
  ) => Promise<ModuleImportPreview>
  importKnowledgeModule: (
    request: KnowledgeImportModuleRequest,
  ) => Promise<ModuleImportResult>
  pickKnowledgeModuleExportPath: (suggestedName: string) => Promise<string | null>
  pickKnowledgeModuleImportPath: () => Promise<string | null>
  listManagedFiles: (id: string) => Promise<ManagedObjectFilesDetail>
  createManagedTextFile: (request: ManagedFilesCreateRequest) => Promise<ManagedObjectFilesDetail>
  readManagedFileContent: (request: ManagedFilesPathRequest) => Promise<ManagedFileContent>
  saveManagedFileContent: (request: ManagedFilesSaveRequest) => Promise<ManagedObjectFilesDetail>
  importManagedTextFile: (request: ManagedFilesImportRequest) => Promise<ManagedObjectFilesDetail>
  pickManagedImportFile: () => Promise<ManagedFilesPickImportResult | null>
  previewManagedSourceUpdate: (request: ManagedFilesPathRequest) => Promise<SourceUpdatePreview>
  applyManagedSourceUpdate: (request: ManagedFilesPathRequest) => Promise<ManagedObjectFilesDetail>
  renameManagedFile: (request: ManagedFilesRenameRequest) => Promise<ManagedObjectFilesDetail>
  removeManagedFile: (request: ManagedFilesPathRequest) => Promise<ManagedObjectFilesDetail>
  setManagedGuidanceRegistration: (
    request: ManagedFilesGuidanceRequest
  ) => Promise<ManagedObjectFilesDetail>
  openManagedObjectRoot: (id: string) => Promise<{ path: string }>
  scanExternalChanges: (id: string) => Promise<ExternalChangeStatus>
  scanAllExternalChanges: () => Promise<ExternalChangeStatus[]>
  previewExternalChanges: (id: string) => Promise<ExternalChangePreview>
  adoptExternalChanges: (id: string) => Promise<SpaceRevision>
  discardExternalChanges: (id: string) => Promise<ExternalChangeStatus>
  onExternalChanges: (cb: (statuses: ExternalChangeStatus[]) => void) => () => void
  popupApplicationMenu: (request: AppMenuPopupRequest) => Promise<void>
  listHosts: () => Promise<SavedHostProfile[]>
  listHostsByEnvironment: (environmentId: string) => Promise<SavedHostProfile[]>
  getHostTree: () => Promise<SavedHostTreeSnapshot>
  addHostFolder: (request: AddHostFolderRequest) => Promise<HostFolder>
  renameHostFolder: (request: RenameHostFolderRequest) => Promise<HostFolder>
  removeHostFolder: (request: RemoveHostFolderRequest) => Promise<FolderRemovalResult>
  moveHost: (request: MoveHostRequest) => Promise<SavedHostProfile>
  addHost: (input: SavedHostInput) => Promise<SavedHostProfile>
  updateHost: (id: string, patch: Partial<SavedHostInput>) => Promise<SavedHostProfile>
  removeHost: (id: string) => Promise<void>
  testHostConnection: (request: HostConnectionTestRequest) => Promise<HostConnectionTestResult>
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: SettingsPatch) => Promise<AppSettings>
  testLlm: (draft: LlmTestRequest) => Promise<LlmTestResult>
  connectSession: (req: ConnectRequest) => Promise<SessionSummary>
  reconnectSession: (sessionId: string) => Promise<SessionSummary>
  closeSession: (sessionId: string) => Promise<void>
  renameSession: (request: RenameSessionRequest) => Promise<SessionSummary>
  duplicateSession: (request: DuplicateSessionRequest) => Promise<SessionSummary>
  closeSessions: (request: CloseSessionsRequest) => Promise<void>
  listSessions: () => Promise<SessionSummary[]>
  selectSessionEnvironment: (request: SessionEnvironmentSelectionRequest) => Promise<SessionSummary>
  loadSessionKnowledge: (request: SessionKnowledgeModuleRequest) => Promise<SessionSummary>
  pinSessionKnowledge: (request: SessionKnowledgeModuleRequest) => Promise<SessionSummary>
  unpinSessionKnowledge: (request: SessionKnowledgeModuleRequest) => Promise<SessionSummary>
  unloadSessionKnowledge: (request: SessionKnowledgeModuleRequest) => Promise<SessionSummary>
  applySessionRevision: (request: SessionApplyRevisionRequest) => Promise<SessionSummary>
  keepSessionRevision: (request: SessionKeepRevisionRequest) => Promise<SessionSummary>
  agentChat: (req: AgentChatRequest) => Promise<string>
  agentClear: (sessionId: string) => Promise<void>
  startNewContext: (sessionId: string) => Promise<SessionSummary>
  agentCancel: (sessionId: string) => void
  sessionSetPolicy: (sessionId: string, policy: ExecPolicy) => void
  respondDangerConfirm: (requestId: string, ok: boolean) => Promise<ApprovalResponseResult>
  respondNoteProposal: (requestId: string, ok: boolean) => Promise<ApprovalResponseResult>
  respondKnowledgeTarget: (
    requestId: string,
    optionIndex: number | null,
  ) => Promise<ApprovalResponseResult>
  respondKnowledgeProposal: (
    request: import('../shared/ipc-types').KnowledgeProposalRespondRequest,
  ) => Promise<import('../shared/ipc-types').KnowledgeProposalResponseResult>
  respondHostVerify: (requestId: string, ok: boolean) => void
  termInput: (sessionId: string, data: string) => void
  termResize: (sessionId: string, cols: number, rows: number) => void
  clipboardReadText: () => Promise<string>
  clipboardWriteText: (text: string) => Promise<void>
  onTermOutput: (cb: (payload: TermOutputPayload) => void) => () => void
  onSessionStatus: (cb: (summary: SessionSummary) => void) => () => void
  onLanguageChanged: (cb: (language: AppLanguage) => void) => () => void
  onAgentEvent: (cb: (event: AgentEvent) => void) => () => void
  onHostVerify: (cb: (req: HostVerifyRequest) => void) => () => void
  onHostVerifyClosed: (cb: (event: HostVerifyClosed) => void) => () => void
}

declare global {
  interface Window {
    spotshell: SpotShellApi
  }
}

export {}
