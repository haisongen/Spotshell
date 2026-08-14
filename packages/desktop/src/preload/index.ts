import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type AgentChatRequest,
  type AgentEvent,
  type ApprovalResponseResult,
  type AddHostFolderRequest,
  type AppMenuPopupRequest,
  type AppSettings,
  type SettingsPatch,
  type ConnectRequest,
  type RenameSessionRequest,
  type DuplicateSessionRequest,
  type CloseSessionsRequest,
  type SessionEnvironmentSelectionRequest,
  type SessionKnowledgeModuleRequest,
  type SessionApplyRevisionRequest,
  type SessionKeepRevisionRequest,
  type ExecPolicy,
  type HostConnectionTestResult,
  type HostConnectionTestRequest,
  type HostFolder,
  type HostVerifyRequest,
  type HostVerifyClosed,
  type LlmTestRequest,
  type LlmTestResult,
  type EnvironmentCreateRequest,
  type EnvironmentDetail,
  type EnvironmentDraftFormRequest,
  type EnvironmentDraftSourceRequest,
  type EnvironmentExportMode,
  type EnvironmentExportPreview,
  type EnvironmentExportPreviewRequest,
  type EnvironmentExportRequest,
  type EnvironmentImportPreview,
  type EnvironmentImportPreviewRequest,
  type EnvironmentImportRequest,
  type EnvironmentImportResult,
  type EnvironmentSummary,
  type KnowledgeCompareRevisionsRequest,
  type KnowledgeCreateRequest,
  type KnowledgeDraftFormRequest,
  type KnowledgeDraftSourceRequest,
  type KnowledgeExportModuleRequest,
  type KnowledgeImportModulePreviewRequest,
  type KnowledgeImportModuleRequest,
  type KnowledgeListRevisionsRequest,
  type KnowledgeModuleDetail,
  type KnowledgeGlobalOnDemandRequest,
  type KnowledgeRestoreAllSeedsRequest,
  type KnowledgeRestoreSeedRequest,
  type SeedModuleStatus,
  type SeedRestorePreview,
  type SeedRestoreResult,
  type KnowledgeModuleAccessSummary,
  type KnowledgeRestoreRevisionRequest,
  type KnowledgeRevisionCleanupRequest,
  type KnowledgeRevision,
  type ModuleDeletePreview,
  type EnvironmentDeletePreview,
  type PermanentDeletePreview,
  type RevisionCleanupPreview,
  type RevisionCleanupResult,
  type RevisionComparison,
  type RevisionHistoryEntry,
  type TrashEntryDetail,
  type TrashEntrySummary,
  type TrashMoveResult,
  type TrashPermanentDeleteRequest,
  type TrashPurgeResult,
  type TrashRestoreResult,
  type ExportedEnvironmentPackage,
  type ExportedKnowledgeModulePackage,
  type ModuleImportPreview,
  type ModuleImportResult,
  type ExternalChangePreview,
  type ExternalChangeStatus,
  type ManagedFileContent,
  type ManagedFilesCreateRequest,
  type ManagedFilesGuidanceRequest,
  type ManagedFilesImportRequest,
  type ManagedFilesPathRequest,
  type ManagedFilesPickImportResult,
  type ManagedFilesRenameRequest,
  type ManagedFilesSaveRequest,
  type ManagedObjectFilesDetail,
  type SourceUpdatePreview,
  type SpaceRevision,
  type MoveHostRequest,
  type FolderRemovalResult,
  type RemoveHostFolderRequest,
  type RenameHostFolderRequest,
  type SavedHostInput,
  type SavedHostProfile,
  type SavedHostTreeSnapshot,
  type SessionSummary,
} from '../shared/ipc-types'

export interface TermOutputPayload {
  sessionId: string
  data: string
}

const api = {
  listEnvironments: (): Promise<EnvironmentSummary[]> =>
    ipcRenderer.invoke(IpcChannels.environmentList),

  createEnvironment: (request: EnvironmentCreateRequest): Promise<EnvironmentDetail> =>
    ipcRenderer.invoke(IpcChannels.environmentCreate, request),

  getEnvironment: (id: string): Promise<EnvironmentDetail> =>
    ipcRenderer.invoke(IpcChannels.environmentGet, { id }),

  saveEnvironmentFormDraft: (
    request: EnvironmentDraftFormRequest
  ): Promise<EnvironmentDetail> =>
    ipcRenderer.invoke(IpcChannels.environmentSaveFormDraft, request),

  saveEnvironmentSourceDraft: (
    request: EnvironmentDraftSourceRequest
  ): Promise<EnvironmentDetail> =>
    ipcRenderer.invoke(IpcChannels.environmentSaveSourceDraft, request),

  publishEnvironmentDraft: (id: string): Promise<SpaceRevision> =>
    ipcRenderer.invoke(IpcChannels.environmentPublish, { id }),

  previewEnvironmentExport: (
    request: EnvironmentExportPreviewRequest,
  ): Promise<EnvironmentExportPreview> =>
    ipcRenderer.invoke(IpcChannels.environmentExportPreview, request),

  exportEnvironment: (
    request: EnvironmentExportRequest,
  ): Promise<ExportedEnvironmentPackage> =>
    ipcRenderer.invoke(IpcChannels.environmentExport, request),

  previewEnvironmentImport: (
    request: EnvironmentImportPreviewRequest,
  ): Promise<EnvironmentImportPreview> =>
    ipcRenderer.invoke(IpcChannels.environmentImportPreview, request),

  importEnvironment: (
    request: EnvironmentImportRequest,
  ): Promise<EnvironmentImportResult> =>
    ipcRenderer.invoke(IpcChannels.environmentImport, request),

  pickEnvironmentExportPath: (suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.environmentPickExportPath, { suggestedName }),

  pickEnvironmentImportPath: (): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.environmentPickImportPath),

  listKnowledgeModules: (): Promise<KnowledgeModuleAccessSummary[]> =>
    ipcRenderer.invoke(IpcChannels.knowledgeList),

  createKnowledgeModule: (request: KnowledgeCreateRequest): Promise<KnowledgeModuleDetail> =>
    ipcRenderer.invoke(IpcChannels.knowledgeCreate, request),

  getKnowledgeModule: (id: string): Promise<KnowledgeModuleDetail> =>
    ipcRenderer.invoke(IpcChannels.knowledgeGet, { id }),

  saveKnowledgeFormDraft: (
    request: KnowledgeDraftFormRequest
  ): Promise<KnowledgeModuleDetail> =>
    ipcRenderer.invoke(IpcChannels.knowledgeSaveFormDraft, request),

  saveKnowledgeSourceDraft: (
    request: KnowledgeDraftSourceRequest
  ): Promise<KnowledgeModuleDetail> =>
    ipcRenderer.invoke(IpcChannels.knowledgeSaveSourceDraft, request),

  publishKnowledgeDraft: (id: string): Promise<KnowledgeRevision> =>
    ipcRenderer.invoke(IpcChannels.knowledgePublish, { id }),

  listKnowledgeRevisions: (
    request: KnowledgeListRevisionsRequest,
  ): Promise<RevisionHistoryEntry[]> =>
    ipcRenderer.invoke(IpcChannels.knowledgeListRevisions, request),

  compareKnowledgeRevisions: (
    request: KnowledgeCompareRevisionsRequest,
  ): Promise<RevisionComparison> =>
    ipcRenderer.invoke(IpcChannels.knowledgeCompareRevisions, request),

  restoreKnowledgeRevision: (
    request: KnowledgeRestoreRevisionRequest,
  ): Promise<KnowledgeRevision> =>
    ipcRenderer.invoke(IpcChannels.knowledgeRestoreRevision, request),

  previewKnowledgeRevisionCleanup: (
    request: KnowledgeRevisionCleanupRequest,
  ): Promise<RevisionCleanupPreview> =>
    ipcRenderer.invoke(IpcChannels.knowledgePreviewRevisionCleanup, request),

  cleanupKnowledgeRevisions: (
    request: KnowledgeRevisionCleanupRequest,
  ): Promise<RevisionCleanupResult> =>
    ipcRenderer.invoke(IpcChannels.knowledgeCleanupRevisions, request),

  previewDeleteKnowledgeModule: (id: string): Promise<ModuleDeletePreview> =>
    ipcRenderer.invoke(IpcChannels.knowledgePreviewDelete, { id }),

  moveKnowledgeModuleToTrash: (id: string): Promise<TrashMoveResult> =>
    ipcRenderer.invoke(IpcChannels.knowledgeMoveToTrash, { id }),

  previewDeleteEnvironment: (id: string): Promise<EnvironmentDeletePreview> =>
    ipcRenderer.invoke(IpcChannels.environmentPreviewDelete, { id }),

  moveEnvironmentToTrash: (id: string): Promise<TrashMoveResult> =>
    ipcRenderer.invoke(IpcChannels.environmentMoveToTrash, { id }),

  listTrash: (): Promise<TrashEntrySummary[]> =>
    ipcRenderer.invoke(IpcChannels.trashList),

  getTrashEntry: (id: string): Promise<TrashEntryDetail> =>
    ipcRenderer.invoke(IpcChannels.trashGet, { id }),

  restoreFromTrash: (id: string): Promise<TrashRestoreResult> =>
    ipcRenderer.invoke(IpcChannels.trashRestore, { id }),

  previewPermanentDelete: (
    request: TrashPermanentDeleteRequest,
  ): Promise<PermanentDeletePreview> =>
    ipcRenderer.invoke(IpcChannels.trashPreviewPermanentDelete, request),

  permanentlyDeleteFromTrash: (request: TrashPermanentDeleteRequest): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.trashPermanentDelete, request),

  purgeExpiredTrash: (): Promise<TrashPurgeResult> =>
    ipcRenderer.invoke(IpcChannels.trashPurgeExpired),

  setKnowledgeGlobalOnDemand: (request: KnowledgeGlobalOnDemandRequest): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.knowledgeSetGlobalOnDemand, request),

  listSeedModules: (): Promise<SeedModuleStatus[]> =>
    ipcRenderer.invoke(IpcChannels.knowledgeListSeedModules),

  previewRestoreSeedModule: (seedKey: string): Promise<SeedRestorePreview> =>
    ipcRenderer.invoke(IpcChannels.knowledgePreviewRestoreSeed, { seedKey }),

  restoreSeedModule: (request: KnowledgeRestoreSeedRequest): Promise<SeedRestoreResult> =>
    ipcRenderer.invoke(IpcChannels.knowledgeRestoreSeed, request),

  restoreAllSeedModules: (
    request?: KnowledgeRestoreAllSeedsRequest,
  ): Promise<SeedRestoreResult[]> =>
    ipcRenderer.invoke(IpcChannels.knowledgeRestoreAllSeeds, request ?? {}),

  exportKnowledgeModule: (
    request: KnowledgeExportModuleRequest,
  ): Promise<ExportedKnowledgeModulePackage> =>
    ipcRenderer.invoke(IpcChannels.knowledgeExportModule, request),

  previewKnowledgeModuleImport: (
    request: KnowledgeImportModulePreviewRequest,
  ): Promise<ModuleImportPreview> =>
    ipcRenderer.invoke(IpcChannels.knowledgeImportModulePreview, request),

  importKnowledgeModule: (
    request: KnowledgeImportModuleRequest,
  ): Promise<ModuleImportResult> =>
    ipcRenderer.invoke(IpcChannels.knowledgeImportModule, request),

  pickKnowledgeModuleExportPath: (suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.knowledgePickExportModulePath, { suggestedName }),

  pickKnowledgeModuleImportPath: (): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.knowledgePickImportModulePath),

  listManagedFiles: (id: string): Promise<ManagedObjectFilesDetail> =>
    ipcRenderer.invoke(IpcChannels.managedFilesList, { id }),

  createManagedTextFile: (request: ManagedFilesCreateRequest): Promise<ManagedObjectFilesDetail> =>
    ipcRenderer.invoke(IpcChannels.managedFilesCreate, request),

  readManagedFileContent: (request: ManagedFilesPathRequest): Promise<ManagedFileContent> =>
    ipcRenderer.invoke(IpcChannels.managedFilesRead, request),

  saveManagedFileContent: (request: ManagedFilesSaveRequest): Promise<ManagedObjectFilesDetail> =>
    ipcRenderer.invoke(IpcChannels.managedFilesSave, request),

  importManagedTextFile: (request: ManagedFilesImportRequest): Promise<ManagedObjectFilesDetail> =>
    ipcRenderer.invoke(IpcChannels.managedFilesImport, request),

  pickManagedImportFile: (): Promise<ManagedFilesPickImportResult | null> =>
    ipcRenderer.invoke(IpcChannels.managedFilesPickImport),

  previewManagedSourceUpdate: (request: ManagedFilesPathRequest): Promise<SourceUpdatePreview> =>
    ipcRenderer.invoke(IpcChannels.managedFilesPreviewSourceUpdate, request),

  applyManagedSourceUpdate: (request: ManagedFilesPathRequest): Promise<ManagedObjectFilesDetail> =>
    ipcRenderer.invoke(IpcChannels.managedFilesApplySourceUpdate, request),

  renameManagedFile: (request: ManagedFilesRenameRequest): Promise<ManagedObjectFilesDetail> =>
    ipcRenderer.invoke(IpcChannels.managedFilesRename, request),

  removeManagedFile: (request: ManagedFilesPathRequest): Promise<ManagedObjectFilesDetail> =>
    ipcRenderer.invoke(IpcChannels.managedFilesRemove, request),

  setManagedGuidanceRegistration: (
    request: ManagedFilesGuidanceRequest
  ): Promise<ManagedObjectFilesDetail> =>
    ipcRenderer.invoke(IpcChannels.managedFilesSetGuidance, request),

  openManagedObjectRoot: (id: string): Promise<{ path: string }> =>
    ipcRenderer.invoke(IpcChannels.knowledgeOpenObjectRoot, { id }),

  scanExternalChanges: (id: string): Promise<ExternalChangeStatus> =>
    ipcRenderer.invoke(IpcChannels.knowledgeScanExternalChanges, { id }),

  scanAllExternalChanges: (): Promise<ExternalChangeStatus[]> =>
    ipcRenderer.invoke(IpcChannels.knowledgeScanAllExternalChanges),

  previewExternalChanges: (id: string): Promise<ExternalChangePreview> =>
    ipcRenderer.invoke(IpcChannels.knowledgePreviewExternalChanges, { id }),

  adoptExternalChanges: (id: string): Promise<SpaceRevision> =>
    ipcRenderer.invoke(IpcChannels.knowledgeAdoptExternalChanges, { id }),

  discardExternalChanges: (id: string): Promise<ExternalChangeStatus> =>
    ipcRenderer.invoke(IpcChannels.knowledgeDiscardExternalChanges, { id }),

  onExternalChanges: (cb: (statuses: ExternalChangeStatus[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, statuses: ExternalChangeStatus[]): void => {
      cb(statuses)
    }
    ipcRenderer.on(IpcChannels.knowledgeExternalChangesEvent, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannels.knowledgeExternalChangesEvent, listener)
    }
  },

  popupApplicationMenu: (request: AppMenuPopupRequest): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.appMenuPopup, request),

  listHosts: (): Promise<SavedHostProfile[]> => ipcRenderer.invoke(IpcChannels.hostsList),

  listHostsByEnvironment: (environmentId: string): Promise<SavedHostProfile[]> =>
    ipcRenderer.invoke(IpcChannels.hostsByEnvironment, { id: environmentId }),

  getHostTree: (): Promise<SavedHostTreeSnapshot> => ipcRenderer.invoke(IpcChannels.hostTreeGet),

  addHostFolder: (request: AddHostFolderRequest): Promise<HostFolder> =>
    ipcRenderer.invoke(IpcChannels.hostFoldersAdd, request),

  renameHostFolder: (request: RenameHostFolderRequest): Promise<HostFolder> =>
    ipcRenderer.invoke(IpcChannels.hostFoldersRename, request),

  removeHostFolder: (request: RemoveHostFolderRequest): Promise<FolderRemovalResult> =>
    ipcRenderer.invoke(IpcChannels.hostFoldersRemove, request),

  moveHost: (request: MoveHostRequest): Promise<SavedHostProfile> =>
    ipcRenderer.invoke(IpcChannels.hostsMove, request),

  addHost: (input: SavedHostInput): Promise<SavedHostProfile> =>
    ipcRenderer.invoke(IpcChannels.hostsAdd, input),

  updateHost: (id: string, patch: Partial<SavedHostInput>): Promise<SavedHostProfile> =>
    ipcRenderer.invoke(IpcChannels.hostsUpdate, id, patch),

  removeHost: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannels.hostsRemove, id),

  testHostConnection: (request: HostConnectionTestRequest): Promise<HostConnectionTestResult> =>
    ipcRenderer.invoke(IpcChannels.hostsTest, request),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IpcChannels.settingsGet),

  setSettings: (patch: SettingsPatch): Promise<AppSettings> =>
    ipcRenderer.invoke(IpcChannels.settingsSet, patch),

  testLlm: (draft: LlmTestRequest): Promise<LlmTestResult> =>
    ipcRenderer.invoke(IpcChannels.settingsTestLlm, draft ?? {}),

  connectSession: (req: ConnectRequest): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionConnect, req),

  reconnectSession: (sessionId: string): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionReconnect, sessionId),

  closeSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.sessionClose, sessionId),

  renameSession: (request: RenameSessionRequest): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionRename, request),

  duplicateSession: (request: DuplicateSessionRequest): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionDuplicate, request),

  closeSessions: (request: CloseSessionsRequest): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.sessionCloseMany, request),

  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke(IpcChannels.sessionList),

  selectSessionEnvironment: (
    request: SessionEnvironmentSelectionRequest,
  ): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionSelectEnvironment, request),

  loadSessionKnowledge: (request: SessionKnowledgeModuleRequest): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionLoadKnowledge, request),
  pinSessionKnowledge: (request: SessionKnowledgeModuleRequest): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionPinKnowledge, request),
  unpinSessionKnowledge: (request: SessionKnowledgeModuleRequest): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionUnpinKnowledge, request),
  unloadSessionKnowledge: (request: SessionKnowledgeModuleRequest): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionUnloadKnowledge, request),

  applySessionRevision: (request: SessionApplyRevisionRequest): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionApplyRevision, request),
  keepSessionRevision: (request: SessionKeepRevisionRequest): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.sessionKeepRevision, request),

  agentChat: (req: AgentChatRequest): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.agentChat, req),

  agentClear: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.agentClear, sessionId),

  startNewContext: (sessionId: string): Promise<SessionSummary> =>
    ipcRenderer.invoke(IpcChannels.agentStartNewContext, sessionId),

  agentCancel: (sessionId: string): void => {
    ipcRenderer.send(IpcChannels.agentCancel, { sessionId })
  },

  sessionSetPolicy: (sessionId: string, policy: ExecPolicy): void => {
    ipcRenderer.send(IpcChannels.sessionSetPolicy, { sessionId, policy })
  },

  respondDangerConfirm: (requestId: string, ok: boolean): Promise<ApprovalResponseResult> =>
    ipcRenderer.invoke(IpcChannels.agentConfirm, { requestId, ok }),

  respondNoteProposal: (requestId: string, ok: boolean): Promise<ApprovalResponseResult> =>
    ipcRenderer.invoke(IpcChannels.agentRespondNote, { requestId, ok }),

  /** `optionIndex: null` means the user declined every offered landing place. */
  respondKnowledgeTarget: (
    requestId: string,
    optionIndex: number | null,
  ): Promise<ApprovalResponseResult> =>
    ipcRenderer.invoke(IpcChannels.agentRespondKnowledgeTarget, { requestId, optionIndex }),

  respondKnowledgeProposal: (
    request: import('../shared/ipc-types').KnowledgeProposalRespondRequest,
  ): Promise<import('../shared/ipc-types').KnowledgeProposalResponseResult> =>
    ipcRenderer.invoke(IpcChannels.agentRespondKnowledgeProposal, request),

  respondHostVerify: (requestId: string, ok: boolean): void => {
    ipcRenderer.send(IpcChannels.hostVerifyRespond, { requestId, ok })
  },

  termInput: (sessionId: string, data: string): void => {
    ipcRenderer.send(IpcChannels.termInput, { sessionId, data })
  },

  termResize: (sessionId: string, cols: number, rows: number): void => {
    ipcRenderer.send(IpcChannels.termResize, { sessionId, cols, rows })
  },

  clipboardReadText: (): Promise<string> => ipcRenderer.invoke(IpcChannels.clipboardReadText),

  clipboardWriteText: (text: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.clipboardWriteText, text),

  onTermOutput: (cb: (payload: TermOutputPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TermOutputPayload): void => {
      cb(payload)
    }
    ipcRenderer.on(IpcChannels.termOutput, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannels.termOutput, listener)
    }
  },

  onSessionStatus: (cb: (summary: SessionSummary) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, summary: SessionSummary): void => {
      cb(summary)
    }
    ipcRenderer.on(IpcChannels.sessionStatus, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannels.sessionStatus, listener)
    }
  },

  onLanguageChanged: (cb: (language: AppLanguage) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, language: AppLanguage): void => {
      cb(language)
    }
    ipcRenderer.on(IpcChannels.languageChanged, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannels.languageChanged, listener)
    }
  },

  onAgentEvent: (cb: (event: AgentEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: AgentEvent): void => {
      cb(event)
    }
    ipcRenderer.on(IpcChannels.agentEvent, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannels.agentEvent, listener)
    }
  },

  onHostVerify: (cb: (req: HostVerifyRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, req: HostVerifyRequest): void => {
      cb(req)
    }
    ipcRenderer.on(IpcChannels.hostVerify, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannels.hostVerify, listener)
    }
  },

  onHostVerifyClosed: (cb: (event: HostVerifyClosed) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: HostVerifyClosed): void => {
      cb(event)
    }
    ipcRenderer.on(IpcChannels.hostVerifyClosed, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannels.hostVerifyClosed, listener)
    }
  },
}

contextBridge.exposeInMainWorld('spotshell', api)
