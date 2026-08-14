import path from 'node:path'
import type { EnvironmentHostBinding, KnowledgeRepository } from '@spotshell/core'
import { BrowserWindow, dialog, shell } from 'electron'
import { z } from 'zod'
import { IpcChannels } from '../shared/ipc-types'
import {
  environmentCreateRequestSchema,
  environmentDraftFormRequestSchema,
  environmentDraftSourceRequestSchema,
  environmentExportPreviewRequestSchema,
  environmentExportRequestSchema,
  environmentIdRequestSchema,
  environmentImportPreviewRequestSchema,
  environmentImportRequestSchema,
  environmentMoveToTrashRequestSchema,
  environmentPickExportPathRequestSchema,
  environmentPreviewDeleteRequestSchema,
  knowledgeAdoptExternalChangesRequestSchema,
  knowledgeCompareRevisionsRequestSchema,
  knowledgeCreateRequestSchema,
  knowledgeDiscardExternalChangesRequestSchema,
  knowledgeDraftFormRequestSchema,
  knowledgeDraftSourceRequestSchema,
  knowledgeExportModuleRequestSchema,
  knowledgeGlobalOnDemandRequestSchema,
  knowledgeIdRequestSchema,
  knowledgeImportModulePreviewRequestSchema,
  knowledgeImportModuleRequestSchema,
  knowledgeListRevisionsRequestSchema,
  knowledgeMoveToTrashRequestSchema,
  knowledgeOpenObjectRootRequestSchema,
  knowledgePickExportModulePathRequestSchema,
  knowledgePreviewDeleteRequestSchema,
  knowledgePreviewExternalChangesRequestSchema,
  knowledgePreviewRestoreSeedRequestSchema,
  knowledgeRestoreAllSeedsRequestSchema,
  knowledgeRestoreRevisionRequestSchema,
  knowledgeRestoreSeedRequestSchema,
  knowledgeRevisionCleanupRequestSchema,
  knowledgeScanExternalChangesRequestSchema,
  managedFilesCreateRequestSchema,
  managedFilesGuidanceRequestSchema,
  managedFilesIdRequestSchema,
  managedFilesImportRequestSchema,
  managedFilesPathRequestSchema,
  managedFilesRenameRequestSchema,
  managedFilesSaveRequestSchema,
  trashIdRequestSchema,
  trashPermanentDeleteRequestSchema,
} from '../shared/ipc-schemas'
import type {
  KnowledgeModuleAccessSummary,
  ManagedFilesPickImportResult,
} from '../shared/ipc-types'
import type { ModuleAuthorizationStore } from './ModuleAuthorizationStore'
import {
  listSeedModuleStatuses,
  previewSeedModuleRestore,
  restoreAllSeedModules,
  restoreSeedModule,
} from './seedModules'

type KnowledgeIpcHandler = (
  event: { sender: { id?: number } },
  payload?: unknown,
) => unknown

export interface KnowledgeIpcRegistrar {
  handle(channel: string, handler: KnowledgeIpcHandler): void
}

/** Local host bindings used to block deleting environments still tied to hosts. */
export interface KnowledgeTrashHostBindings {
  listBoundHosts(environmentId: string): EnvironmentHostBinding[]
}

export function registerKnowledgeIpc(
  registrar: KnowledgeIpcRegistrar,
  repository: KnowledgeRepository,
  authorizations: ModuleAuthorizationStore,
  hostBindings?: KnowledgeTrashHostBindings,
  knowledgeRootPath?: string,
  onPublishedKnowledgeChange?: () => void | Promise<void>,
): void {
  const notifyPublishedKnowledgeChange = async (): Promise<void> => {
    try {
      await onPublishedKnowledgeChange?.()
    } catch {
      // The repository mutation has committed; notification is best-effort.
    }
  }

  registrar.handle(IpcChannels.knowledgeList, async () => listModuleAccess(repository, authorizations))

  registrar.handle(IpcChannels.knowledgeCreate, async (_event, payload) => {
    const request = required(knowledgeCreateRequestSchema, payload)
    return repository.createDraft(request)
  })

  registrar.handle(IpcChannels.knowledgeGet, async (_event, payload) => {
    const request = required(knowledgeIdRequestSchema, payload)
    return repository.getModule(request.id)
  })

  registrar.handle(IpcChannels.knowledgeSaveFormDraft, async (_event, payload) => {
    const request = required(knowledgeDraftFormRequestSchema, payload)
    return repository.saveFormDraft(request.id, request.form)
  })

  registrar.handle(IpcChannels.knowledgeSaveSourceDraft, async (_event, payload) => {
    const request = required(knowledgeDraftSourceRequestSchema, payload)
    return repository.saveSourceDraft(request.id, request.source)
  })

  registrar.handle(IpcChannels.knowledgePublish, async (_event, payload) => {
    const request = required(knowledgeIdRequestSchema, payload)
    const revision = await repository.publishDraft(request.id)
    await notifyPublishedKnowledgeChange()
    return revision
  })

  registrar.handle(IpcChannels.knowledgeListRevisions, async (_event, payload) => {
    const request = required(knowledgeListRevisionsRequestSchema, payload)
    return repository.listRevisionHistory(request.id, {
      agentActiveRevisions: request.agentActiveRevisions,
      proposalTargetRevisions: request.proposalTargetRevisions,
      recoveryRequiredRevisions: request.recoveryRequiredRevisions,
    })
  })

  registrar.handle(IpcChannels.knowledgeCompareRevisions, async (_event, payload) => {
    const request = required(knowledgeCompareRevisionsRequestSchema, payload)
    return repository.compareRevisions(
      request.id,
      request.leftRevision,
      request.rightRevision,
    )
  })

  registrar.handle(IpcChannels.knowledgeRestoreRevision, async (_event, payload) => {
    const request = required(knowledgeRestoreRevisionRequestSchema, payload)
    return repository.restoreRevision(request.id, request.revision)
  })

  registrar.handle(IpcChannels.knowledgePreviewRevisionCleanup, async (_event, payload) => {
    const request = required(knowledgeRevisionCleanupRequestSchema, payload)
    return repository.previewRevisionCleanup(request.id, request.revisions, {
      agentActiveRevisions: request.agentActiveRevisions,
      proposalTargetRevisions: request.proposalTargetRevisions,
      recoveryRequiredRevisions: request.recoveryRequiredRevisions,
    })
  })

  registrar.handle(IpcChannels.knowledgeCleanupRevisions, async (_event, payload) => {
    const request = required(knowledgeRevisionCleanupRequestSchema, payload)
    return repository.cleanupRevisions(request.id, request.revisions, {
      agentActiveRevisions: request.agentActiveRevisions,
      proposalTargetRevisions: request.proposalTargetRevisions,
      recoveryRequiredRevisions: request.recoveryRequiredRevisions,
    })
  })

  registrar.handle(IpcChannels.knowledgePreviewDelete, async (_event, payload) => {
    const request = required(knowledgePreviewDeleteRequestSchema, payload)
    return repository.previewDeleteModule(request.id)
  })

  registrar.handle(IpcChannels.knowledgeMoveToTrash, async (_event, payload) => {
    const request = required(knowledgeMoveToTrashRequestSchema, payload)
    return repository.moveModuleToTrash(request.id)
  })

  registrar.handle(IpcChannels.environmentPreviewDelete, async (_event, payload) => {
    const request = required(environmentPreviewDeleteRequestSchema, payload)
    const boundHosts = hostBindings?.listBoundHosts(request.id) ?? []
    return repository.previewDeleteEnvironment(request.id, boundHosts)
  })

  registrar.handle(IpcChannels.environmentMoveToTrash, async (_event, payload) => {
    const request = required(environmentMoveToTrashRequestSchema, payload)
    const boundHosts = hostBindings?.listBoundHosts(request.id) ?? []
    return repository.moveEnvironmentToTrash(request.id, boundHosts)
  })

  registrar.handle(IpcChannels.trashList, async () => repository.listTrash())

  registrar.handle(IpcChannels.trashGet, async (_event, payload) => {
    const request = required(trashIdRequestSchema, payload)
    return repository.getTrashEntry(request.id)
  })

  registrar.handle(IpcChannels.trashRestore, async (_event, payload) => {
    const request = required(trashIdRequestSchema, payload)
    return repository.restoreFromTrash(request.id)
  })

  registrar.handle(IpcChannels.trashPreviewPermanentDelete, async (_event, payload) => {
    const request = required(trashPermanentDeleteRequestSchema, payload)
    return repository.previewPermanentDelete(request.id, {
      agentActiveRevisions: request.agentActiveRevisions,
    })
  })

  registrar.handle(IpcChannels.trashPermanentDelete, async (_event, payload) => {
    const request = required(trashPermanentDeleteRequestSchema, payload)
    await repository.permanentlyDeleteFromTrash(request.id, {
      agentActiveRevisions: request.agentActiveRevisions,
    })
  })

  registrar.handle(IpcChannels.trashPurgeExpired, async () => repository.purgeExpiredTrash())

  registrar.handle(IpcChannels.knowledgeSetGlobalOnDemand, async (_event, payload) => {
    const request = required(knowledgeGlobalOnDemandRequestSchema, payload)
    await repository.getModule(request.id)
    if (request.authorized) {
      const candidates = await repository.listAutomaticCandidates()
      if (!candidates.some((candidate) => candidate.id === request.id)) {
        throw new Error('Global authorization requires an eligible published revision')
      }
    }
    authorizations.setGlobalOnDemand(request.id, request.authorized)
  })

  registrar.handle(IpcChannels.knowledgeListSeedModules, async () => {
    if (!knowledgeRootPath) throw new Error('Knowledge root path is not configured')
    return listSeedModuleStatuses(repository, knowledgeRootPath)
  })

  registrar.handle(IpcChannels.knowledgePreviewRestoreSeed, async (_event, payload) => {
    if (!knowledgeRootPath) throw new Error('Knowledge root path is not configured')
    const request = required(knowledgePreviewRestoreSeedRequestSchema, payload)
    return previewSeedModuleRestore(repository, knowledgeRootPath, request.seedKey)
  })

  registrar.handle(IpcChannels.knowledgeRestoreSeed, async (_event, payload) => {
    if (!knowledgeRootPath) throw new Error('Knowledge root path is not configured')
    const request = required(knowledgeRestoreSeedRequestSchema, payload)
    return restoreSeedModule(repository, knowledgeRootPath, authorizations, request)
  })

  registrar.handle(IpcChannels.knowledgeRestoreAllSeeds, async (_event, payload) => {
    if (!knowledgeRootPath) throw new Error('Knowledge root path is not configured')
    const request = required(knowledgeRestoreAllSeedsRequestSchema, payload ?? {})
    return restoreAllSeedModules(repository, knowledgeRootPath, authorizations, request)
  })

  registrar.handle(IpcChannels.environmentList, async () => repository.listEnvironments())

  registrar.handle(IpcChannels.environmentCreate, async (_event, payload) => {
    const request = required(environmentCreateRequestSchema, payload)
    return repository.createEnvironmentDraft(request)
  })

  registrar.handle(IpcChannels.environmentGet, async (_event, payload) => {
    const request = required(environmentIdRequestSchema, payload)
    return repository.getEnvironment(request.id)
  })

  registrar.handle(IpcChannels.environmentSaveFormDraft, async (_event, payload) => {
    const request = required(environmentDraftFormRequestSchema, payload)
    return repository.saveEnvironmentFormDraft(request.id, request.form)
  })

  registrar.handle(IpcChannels.environmentSaveSourceDraft, async (_event, payload) => {
    const request = required(environmentDraftSourceRequestSchema, payload)
    return repository.saveEnvironmentSourceDraft(request.id, request.source)
  })

  registrar.handle(IpcChannels.environmentPublish, async (_event, payload) => {
    const request = required(environmentIdRequestSchema, payload)
    const revision = await repository.publishEnvironmentDraft(request.id)
    await notifyPublishedKnowledgeChange()
    return revision
  })

  registrar.handle(IpcChannels.environmentExportPreview, async (_event, payload) => {
    const request = required(environmentExportPreviewRequestSchema, payload)
    return repository.previewEnvironmentExport(request.id)
  })

  registrar.handle(IpcChannels.environmentExport, async (_event, payload) => {
    const request = required(environmentExportRequestSchema, payload)
    return repository.exportEnvironment(
      request.id,
      request.packagePath,
      request.mode ?? 'self-contained',
    )
  })

  registrar.handle(IpcChannels.environmentImportPreview, async (_event, payload) => {
    const request = required(environmentImportPreviewRequestSchema, payload)
    return repository.previewEnvironmentImport(request.packagePath)
  })

  registrar.handle(IpcChannels.environmentImport, async (_event, payload) => {
    const request = required(environmentImportRequestSchema, payload)
    return repository.importEnvironment(request.packagePath, {
      environmentResolution: request.environmentResolution,
      moduleResolutions: request.moduleResolutions,
    })
  })

  registrar.handle(IpcChannels.environmentPickExportPath, async (event, payload) => {
    const request = required(environmentPickExportPathRequestSchema, payload)
    const browserWindow = BrowserWindow.fromWebContents(
      event.sender as Parameters<typeof BrowserWindow.fromWebContents>[0],
    )
    const suggestedName = request.suggestedName.endsWith('.spotshell-environment.json')
      ? request.suggestedName
      : `${request.suggestedName}.spotshell-environment.json`
    const dialogOptions = {
      title: 'Export environment package',
      defaultPath: suggestedName,
      filters: [
        { name: 'SpotShell environment package', extensions: ['json'] },
      ],
    }
    const result = browserWindow
      ? await dialog.showSaveDialog(browserWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  registrar.handle(IpcChannels.environmentPickImportPath, async (event) => {
    const browserWindow = BrowserWindow.fromWebContents(
      event.sender as Parameters<typeof BrowserWindow.fromWebContents>[0],
    )
    const dialogOptions = {
      title: 'Import environment package',
      properties: ['openFile' as const],
      filters: [
        { name: 'SpotShell environment package', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }
    const result = browserWindow
      ? await dialog.showOpenDialog(browserWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]!
  })

  registrar.handle(IpcChannels.managedFilesList, async (_event, payload) => {
    const request = required(managedFilesIdRequestSchema, payload)
    return repository.listManagedFiles(request.id)
  })

  registrar.handle(IpcChannels.managedFilesCreate, async (_event, payload) => {
    const request = required(managedFilesCreateRequestSchema, payload)
    return repository.createManagedTextFile(request.id, {
      relativePath: request.relativePath,
      content: request.content,
    })
  })

  registrar.handle(IpcChannels.managedFilesRead, async (_event, payload) => {
    const request = required(managedFilesPathRequestSchema, payload)
    return repository.readManagedFileContent(request.id, request.relativePath)
  })

  registrar.handle(IpcChannels.managedFilesSave, async (_event, payload) => {
    const request = required(managedFilesSaveRequestSchema, payload)
    return repository.saveManagedFileContent(request.id, request.relativePath, request.content)
  })

  registrar.handle(IpcChannels.managedFilesImport, async (_event, payload) => {
    const request = required(managedFilesImportRequestSchema, payload)
    return repository.importManagedTextFile(request.id, {
      relativePath: request.relativePath,
      absoluteSourcePath: request.absoluteSourcePath,
    })
  })

  registrar.handle(IpcChannels.managedFilesPickImport, async (event) => {
    const sender = event.sender as Parameters<typeof BrowserWindow.fromWebContents>[0]
    const browserWindow = BrowserWindow.fromWebContents(sender)
    const dialogOptions = {
      properties: ['openFile' as const],
      filters: [
        {
          name: 'Text files',
          extensions: [
            'md', 'txt', 'log', 'json', 'yaml', 'yml', 'xml', 'conf', 'config',
            'ini', 'toml', 'env', 'sh', 'bash', 'zsh', 'ps1', 'py', 'js', 'ts',
            'tsx', 'jsx', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb',
            'php', 'sql', 'css', 'html', 'properties',
          ],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    }
    const result = browserWindow
      ? await dialog.showOpenDialog(browserWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return null
    const absoluteSourcePath = result.filePaths[0]!
    const pick: ManagedFilesPickImportResult = {
      absoluteSourcePath,
      suggestedRelativePath: path.basename(absoluteSourcePath),
    }
    return pick
  })

  registrar.handle(IpcChannels.managedFilesPreviewSourceUpdate, async (_event, payload) => {
    const request = required(managedFilesPathRequestSchema, payload)
    return repository.previewUpdateFromSource(request.id, request.relativePath)
  })

  registrar.handle(IpcChannels.managedFilesApplySourceUpdate, async (_event, payload) => {
    const request = required(managedFilesPathRequestSchema, payload)
    return repository.applyUpdateFromSource(request.id, request.relativePath)
  })

  registrar.handle(IpcChannels.managedFilesRename, async (_event, payload) => {
    const request = required(managedFilesRenameRequestSchema, payload)
    return repository.renameManagedFile(
      request.id,
      request.fromRelativePath,
      request.toRelativePath,
    )
  })

  registrar.handle(IpcChannels.managedFilesRemove, async (_event, payload) => {
    const request = required(managedFilesPathRequestSchema, payload)
    return repository.removeManagedFile(request.id, request.relativePath)
  })

  registrar.handle(IpcChannels.managedFilesSetGuidance, async (_event, payload) => {
    const request = required(managedFilesGuidanceRequestSchema, payload)
    return repository.setGuidanceRegistration(
      request.id,
      request.relativePath,
      request.registered,
    )
  })

  registrar.handle(IpcChannels.knowledgeOpenObjectRoot, async (_event, payload) => {
    const request = required(knowledgeOpenObjectRootRequestSchema, payload)
    const rootPath = await repository.getManagedObjectRootPath(request.id)
    const errorMessage = await shell.openPath(rootPath)
    if (errorMessage) {
      throw new Error(`Could not open managed object folder: ${errorMessage}`)
    }
    return { path: rootPath }
  })

  registrar.handle(IpcChannels.knowledgeScanExternalChanges, async (_event, payload) => {
    const request = required(knowledgeScanExternalChangesRequestSchema, payload)
    return repository.scanExternalChanges(request.id)
  })

  registrar.handle(IpcChannels.knowledgeScanAllExternalChanges, async () => {
    return repository.scanAllExternalChanges()
  })

  registrar.handle(IpcChannels.knowledgePreviewExternalChanges, async (_event, payload) => {
    const request = required(knowledgePreviewExternalChangesRequestSchema, payload)
    return repository.previewExternalChanges(request.id)
  })

  registrar.handle(IpcChannels.knowledgeAdoptExternalChanges, async (_event, payload) => {
    const request = required(knowledgeAdoptExternalChangesRequestSchema, payload)
    return repository.adoptExternalChanges(request.id)
  })

  registrar.handle(IpcChannels.knowledgeDiscardExternalChanges, async (_event, payload) => {
    const request = required(knowledgeDiscardExternalChangesRequestSchema, payload)
    await repository.discardExternalChanges(request.id)
    return repository.scanExternalChanges(request.id)
  })

  registrar.handle(IpcChannels.knowledgeExportModule, async (_event, payload) => {
    const request = required(knowledgeExportModuleRequestSchema, payload)
    return repository.exportKnowledgeModule(request.id, request.packagePath)
  })

  registrar.handle(IpcChannels.knowledgeImportModulePreview, async (_event, payload) => {
    const request = required(knowledgeImportModulePreviewRequestSchema, payload)
    return repository.previewKnowledgeModuleImport(request.packagePath)
  })

  registrar.handle(IpcChannels.knowledgeImportModule, async (_event, payload) => {
    const request = required(knowledgeImportModuleRequestSchema, payload)
    return repository.importKnowledgeModule(request.packagePath, request.conflictResolution)
  })

  registrar.handle(IpcChannels.knowledgePickExportModulePath, async (event, payload) => {
    const request = required(knowledgePickExportModulePathRequestSchema, payload)
    const browserWindow = BrowserWindow.fromWebContents(
      event.sender as Parameters<typeof BrowserWindow.fromWebContents>[0],
    )
    const suggestedName = request.suggestedName.endsWith('.spotshell-module.json')
      ? request.suggestedName
      : `${request.suggestedName}.spotshell-module.json`
    const dialogOptions = {
      title: 'Export knowledge module',
      defaultPath: suggestedName,
      filters: [
        { name: 'SpotShell knowledge module', extensions: ['json'] },
      ],
    }
    const result = browserWindow
      ? await dialog.showSaveDialog(browserWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  registrar.handle(IpcChannels.knowledgePickImportModulePath, async (event) => {
    const browserWindow = BrowserWindow.fromWebContents(
      event.sender as Parameters<typeof BrowserWindow.fromWebContents>[0],
    )
    const dialogOptions = {
      title: 'Import knowledge module',
      properties: ['openFile' as const],
      filters: [
        { name: 'SpotShell knowledge module', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }
    const result = browserWindow
      ? await dialog.showOpenDialog(browserWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]!
  })
}

async function listModuleAccess(
  repository: KnowledgeRepository,
  authorizations: ModuleAuthorizationStore,
): Promise<KnowledgeModuleAccessSummary[]> {
  const [modules, candidates, environmentSummaries] = await Promise.all([
    repository.listModules(),
    repository.listAutomaticCandidates(),
    repository.listEnvironments(),
  ])
  const environments = await Promise.all(
    environmentSummaries.map((environment) => repository.getEnvironment(environment.id))
  )
  const eligibleIds = new Set(candidates.map((candidate) => candidate.id))
  const authorizedIds = new Set(authorizations.listGlobalOnDemandIds())
  return modules.map((module) => ({
    ...module,
    automaticCandidateEligible: eligibleIds.has(module.id),
    globalOnDemand: authorizedIds.has(module.id),
    environmentAlways: environments
      .filter((environment) => environment.form?.always.includes(module.id))
      .map(({ id, name }) => ({ id, name })),
    environmentOnDemand: environments
      .filter((environment) => environment.form?.onDemand.includes(module.id))
      .map(({ id, name }) => ({ id, name })),
  }))
}

function required<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new Error('Invalid payload')
  return parsed.data
}
