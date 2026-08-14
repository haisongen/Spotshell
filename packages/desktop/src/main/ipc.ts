import { ipcMain, BrowserWindow, clipboard } from 'electron'
import {
  type FolderRemovalResult,
  type HostFolder,
  type HostProfile,
  type HostProfileInput,
  type KnowledgeRepository,
} from '@spotshell/core'
import { z } from 'zod'
import {
  IpcChannels,
  type AgentEvent,
  type ApprovalResponseResult,
  type KnowledgeProposalResponseResult,
  type AppMenuPopupRequest,
  type AddHostFolderRequest,
  type HostConnectionTestResult,
  type HostConnectionTestRequest,
  type HostVerifyRequest,
  type HostVerifyClosed,
  type MoveHostRequest,
  type RemoveHostFolderRequest,
  type RenameHostFolderRequest,
  type RenameSessionRequest,
  type DuplicateSessionRequest,
  type CloseSessionsRequest,
  type SessionEnvironmentSelectionRequest,
  type SessionKnowledgeModuleRequest,
  type SessionApplyRevisionRequest,
  type SessionKeepRevisionRequest,
  type SavedHostProfile,
  type SavedHostTreeSnapshot,
} from '../shared/ipc-types'
import { hostStore, hostCredentialStore } from './hostsStore'
import { testLlmConnection } from './llmProbe'
import { settingsStore } from './settingsStore'
import { probeHostConnection } from './hostConnectionProbe'
import { resolveHostTestRequest } from './hostTestRequest'
import type { SessionManager } from './SessionManager'
import type { HostEnvironmentBindings } from './HostEnvironmentBindings'
import { assertSavedHostIdentity } from './connectionAuth'
import { applyNativeTheme } from './theme'
import { popupApplicationMenu } from './appMenu'
import { registerKnowledgeIpc } from './knowledgeIpc'
import type { ModuleAuthorizationStore } from './ModuleAuthorizationStore'
import { knowledgeRootPath } from './paths'
import {
  appMenuPopupRequestSchema,
  addHostFolderRequestSchema,
  agentCancelSchema,
  agentChatRequestSchema,
  agentClearSchema,
  agentConfirmRespondSchema,
  connectRequestSchema,
  closeSessionsRequestSchema,
  duplicateSessionRequestSchema,
  clipboardTextSchema,
  hostVerifyRespondSchema,
  hostConnectionTestRequestSchema,
  llmTestRequestSchema,
  moveHostRequestSchema,
  knowledgeTargetRespondSchema,
  noteRespondSchema,
  knowledgeProposalRespondSchema,
  removeHostFolderRequestSchema,
  renameHostFolderRequestSchema,
  renameSessionRequestSchema,
  savedHostInputSchema,
  savedHostPatchSchema,
  sessionEnvironmentSelectionRequestSchema,
  sessionKnowledgeModuleRequestSchema,
  sessionApplyRevisionRequestSchema,
  sessionKeepRevisionRequestSchema,
  environmentIdRequestSchema,
  sessionIdSchema,
  setPolicySchema,
  settingsUpdateSchema,
  termInputSchema,
  termResizeSchema,
} from '../shared/ipc-schemas'

function parsed<T>(schema: z.ZodType<T>, payload: unknown): T | null {
  const result = schema.safeParse(payload)
  return result.success ? result.data : null
}

function required<T>(schema: z.ZodType<T>, payload: unknown): T {
  const value = parsed(schema, payload)
  if (value === null) throw new Error('Invalid payload')
  return value
}

function publicHost(host: HostProfile): SavedHostProfile {
  return { ...host, hasPassword: hostCredentialStore.has(host.id) }
}

function hostStoreOperation<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Host tree operation failed')
  }
}

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  sessionManager: SessionManager,
  knowledgeRepository: KnowledgeRepository,
  hostEnvironmentBindings: HostEnvironmentBindings,
  moduleAuthorizations: ModuleAuthorizationStore,
): void {
  registerKnowledgeIpc(
    ipcMain,
    knowledgeRepository,
    moduleAuthorizations,
    {
      listBoundHosts(environmentId) {
        return hostEnvironmentBindings.listHosts(environmentId).map((host) => ({
          hostId: host.id,
          hostName: host.name || host.host,
        }))
      },
    },
    knowledgeRootPath(),
    () => sessionManager.refreshKnowledgeRevisionUpdates(),
  )

  ipcMain.handle(IpcChannels.appMenuPopup, async (event, payload: unknown) => {
    const request: AppMenuPopupRequest = required(appMenuPopupRequestSchema, payload)
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    const currentWindow = getWindow()
    if (!senderWindow || senderWindow !== currentWindow || senderWindow.isDestroyed()) {
      throw new Error('Menu popup request did not originate from the SpotShell window')
    }

    const { width, height } = senderWindow.getContentBounds()
    const x = Math.min(Math.max(request.x, 0), Math.max(width - 1, 0))
    const y = Math.min(Math.max(request.y, 0), Math.max(height - 1, 0))
    await popupApplicationMenu(senderWindow, request.menuId, x, y)
  })

  ipcMain.handle(IpcChannels.hostsList, async () => hostStore.list().map(publicHost))

  ipcMain.handle(IpcChannels.hostsByEnvironment, async (_e, payload: unknown) => {
    const request = required(environmentIdRequestSchema, payload)
    return hostEnvironmentBindings.listHosts(request.id).map(publicHost)
  })

  ipcMain.handle(IpcChannels.hostTreeGet, async (): Promise<SavedHostTreeSnapshot> => {
    const tree = hostStore.getTree()
    return { folders: tree.folders, hosts: tree.hosts.map(publicHost) }
  })

  ipcMain.handle(IpcChannels.hostFoldersAdd, async (_e, payload: unknown): Promise<HostFolder> => {
    const input: AddHostFolderRequest = required(addHostFolderRequestSchema, payload)
    return hostStoreOperation(() => hostStore.addFolder(input))
  })

  ipcMain.handle(
    IpcChannels.hostFoldersRename,
    async (_e, payload: unknown): Promise<HostFolder> => {
      const input: RenameHostFolderRequest = required(renameHostFolderRequestSchema, payload)
      return hostStoreOperation(() => hostStore.renameFolder(input.id, input.name))
    }
  )

  ipcMain.handle(
    IpcChannels.hostFoldersRemove,
    async (_e, payload: unknown): Promise<FolderRemovalResult> => {
      const input: RemoveHostFolderRequest = required(removeHostFolderRequestSchema, payload)
      return hostStoreOperation(() => hostStore.removeFolder(input.id))
    }
  )

  ipcMain.handle(IpcChannels.hostsMove, async (_e, payload: unknown): Promise<SavedHostProfile> => {
    const input: MoveHostRequest = required(moveHostRequestSchema, payload)
    return publicHost(hostStoreOperation(() => hostStore.moveHost(input.hostId, input.folderId)))
  })

  ipcMain.handle(IpcChannels.hostsAdd, async (_e, payload: unknown) => {
    const input = required(savedHostInputSchema, payload)
    const { password, ...profileInput } = input
    if (profileInput.environmentId) {
      await hostEnvironmentBindings.assertEnvironmentExists(profileInput.environmentId)
    }
    const host = hostStore.add(profileInput)
    if (password) {
      try {
        hostCredentialStore.set(host.id, password)
      } catch (error) {
        hostStore.remove(host.id)
        throw error
      }
    }
    return publicHost(host)
  })

  ipcMain.handle(
    IpcChannels.hostsUpdate,
    async (_e, idPayload: unknown, patchPayload: unknown) => {
      const id = required(sessionIdSchema, idPayload)
      const patch = required(savedHostPatchSchema, patchPayload)
      const { password, ...profilePatch } = patch
      if (profilePatch.environmentId) {
        await hostEnvironmentBindings.assertEnvironmentExists(profilePatch.environmentId)
      }
      const host = hostStore.update(id, profilePatch as Partial<HostProfileInput>)
      if (password !== undefined) hostCredentialStore.set(id, password)
      return publicHost(host)
    }
  )

  ipcMain.handle(IpcChannels.hostsRemove, async (_e, payload: unknown) => {
    const id = required(sessionIdSchema, payload)
    hostStore.remove(id)
    hostCredentialStore.remove(id)
  })

  ipcMain.handle(IpcChannels.hostsTest, async (_e, payload: unknown): Promise<HostConnectionTestResult> => {
    const request: HostConnectionTestRequest = required(hostConnectionTestRequestSchema, payload)
    const host = hostStore.get(request.hostId)
    if (!host) {
      return { ok: false, message: 'Saved host not found', latencyMs: 0 }
    }

    const shouldLoadSavedPassword = request.draft
      ? request.draft.authMethod === 'password' &&
        request.draft.useSavedPassword &&
        !request.draft.password
      : host.authMethod !== 'agent' && host.authMethod !== 'key'
    const resolution = resolveHostTestRequest(
      host,
      request.draft,
      shouldLoadSavedPassword ? hostCredentialStore.get(request.hostId) : undefined
    )
    if (!resolution.ok) return { ok: false, message: resolution.message, latencyMs: 0 }

    const connectionId = `host-test:${crypto.randomUUID()}`
    let hostKeyRefused = false
    try {
      const result = await probeHostConnection({
        ...resolution.input,
        hostVerifier: async ({ fingerprint }) => {
          const ok = await sessionManager.verifyConnectionHostKey(
            connectionId,
            { host: resolution.input.host, port: resolution.input.port },
            fingerprint
          )
          hostKeyRefused = !ok
          return ok
        },
      })
      return hostKeyRefused && !result.ok
        ? { ...result, message: 'Host key verification was refused' }
        : result
    } finally {
      sessionManager.cancelHostVerification(connectionId)
    }
  })

  ipcMain.handle(IpcChannels.settingsGet, async () => {
    return settingsStore.getPublicSettings()
  })

  ipcMain.handle(IpcChannels.settingsSet, async (_e, payload: unknown) => {
    const patch = required(settingsUpdateSchema, payload)
    const settings = settingsStore.update(patch)
    applyNativeTheme(settings.theme, getWindow())
    if (patch.model !== undefined) {
      sessionManager.refreshAllAgentModels()
    } else if (patch.allowAutoContextCompaction !== undefined) {
      sessionManager.refreshAllContextUsage()
    }
    return settings
  })

  ipcMain.handle(IpcChannels.clipboardReadText, async () => clipboard.readText())

  ipcMain.handle(IpcChannels.clipboardWriteText, async (_e, payload: unknown) => {
    clipboard.writeText(required(clipboardTextSchema, payload))
  })

  ipcMain.handle(IpcChannels.settingsTestLlm, async (_e, payload: unknown) => {
    const draft = required(llmTestRequestSchema, payload)
    return testLlmConnection(draft)
  })

  ipcMain.handle(IpcChannels.sessionConnect, async (_e, payload: unknown) => {
    const req = required(connectRequestSchema, payload)
    const savedHost = req.hostId ? hostStore.get(req.hostId) : undefined
    assertSavedHostIdentity(req, savedHost)
    const savedPassword = savedHost && !req.useAgent
      ? hostCredentialStore.get(savedHost.id)
      : undefined
    return sessionManager.connect({
      ...req,
      password: req.useAgent ? undefined : req.password || savedPassword,
    })
  })

  ipcMain.handle(IpcChannels.sessionReconnect, async (_e, payload: unknown) => {
    const sessionId = required(sessionIdSchema, payload)
    return sessionManager.reconnect(sessionId)
  })

  ipcMain.handle(IpcChannels.sessionClose, async (_e, payload: unknown) => {
    const sessionId = required(sessionIdSchema, payload)
    sessionManager.close(sessionId)
  })

  ipcMain.handle(IpcChannels.sessionList, async () => {
    return sessionManager.list()
  })

  ipcMain.handle(IpcChannels.sessionSelectEnvironment, async (_e, payload: unknown) => {
    const request: SessionEnvironmentSelectionRequest = required(
      sessionEnvironmentSelectionRequestSchema,
      payload,
    )
    return sessionManager.selectEnvironment(
      request.sessionId,
      request.environmentId,
      request.persistForHost,
    )
  })

  for (const [channel, operation] of [
    [IpcChannels.sessionLoadKnowledge, (request: SessionKnowledgeModuleRequest) => sessionManager.loadKnowledgeModule(request.sessionId, request.moduleId)],
    [IpcChannels.sessionPinKnowledge, (request: SessionKnowledgeModuleRequest) => sessionManager.pinKnowledgeModule(request.sessionId, request.moduleId)],
    [IpcChannels.sessionUnpinKnowledge, (request: SessionKnowledgeModuleRequest) => sessionManager.unpinKnowledgeModule(request.sessionId, request.moduleId)],
    [IpcChannels.sessionUnloadKnowledge, (request: SessionKnowledgeModuleRequest) => sessionManager.unloadKnowledgeModule(request.sessionId, request.moduleId)],
  ] as const) {
    ipcMain.handle(channel, async (_e, payload: unknown) => {
      const request = required(sessionKnowledgeModuleRequestSchema, payload)
      return operation(request)
    })
  }

  ipcMain.handle(IpcChannels.sessionApplyRevision, async (_e, payload: unknown) => {
    const request: SessionApplyRevisionRequest = required(sessionApplyRevisionRequestSchema, payload)
    return sessionManager.applyKnowledgeRevision(request)
  })

  ipcMain.handle(IpcChannels.sessionKeepRevision, async (_e, payload: unknown) => {
    const request: SessionKeepRevisionRequest = required(sessionKeepRevisionRequestSchema, payload)
    return sessionManager.keepKnowledgeRevision(request)
  })

  ipcMain.handle(IpcChannels.agentChat, async (_e, payload: unknown) => {
    const req = required(agentChatRequestSchema, payload)
    return sessionManager.chat(req.sessionId, req.message, req.quotes ?? [])
  })

  ipcMain.handle(IpcChannels.agentClear, async (_e, payload: unknown) => {
    const sessionId = required(agentClearSchema, payload)
    sessionManager.clearHistory(sessionId)
  })

  ipcMain.handle(IpcChannels.agentStartNewContext, async (_e, payload: unknown) => {
    const sessionId = required(agentClearSchema, payload)
    return sessionManager.startNewContext(sessionId)
  })

  ipcMain.handle(
    IpcChannels.agentConfirm,
    async (_e, payload: unknown): Promise<ApprovalResponseResult> => {
      const value = required(agentConfirmRespondSchema, payload)
      return sessionManager.respondConfirm(value.requestId, value.ok)
    }
  )

  ipcMain.handle(
    IpcChannels.agentRespondNote,
    async (_e, payload: unknown): Promise<ApprovalResponseResult> => {
      const value = required(noteRespondSchema, payload)
      return sessionManager.respondNoteProposal(value.requestId, value.ok)
    }
  )

  ipcMain.handle(
    IpcChannels.agentRespondKnowledgeTarget,
    async (_e, payload: unknown): Promise<ApprovalResponseResult> => {
      const value = required(knowledgeTargetRespondSchema, payload)
      return sessionManager.respondKnowledgeTarget(value.requestId, value.optionIndex)
    }
  )

  ipcMain.handle(
    IpcChannels.agentRespondKnowledgeProposal,
    async (_e, payload: unknown): Promise<KnowledgeProposalResponseResult> => {
      const value = required(knowledgeProposalRespondSchema, payload)
      return sessionManager.respondKnowledgeProposal(value.requestId, {
        ok: value.ok,
        reason: value.reason,
        terminalEvidence: value.terminalEvidence,
        files: value.files,
        promoteToGuidance: value.promoteToGuidance,
      })
    }
  )

  ipcMain.on(IpcChannels.agentCancel, (_e, payload: unknown) => {
    const value = parsed(agentCancelSchema, payload)
    if (!value) return
    sessionManager.cancelChat(value.sessionId)
  })

  ipcMain.on(
    IpcChannels.sessionSetPolicy,
    (_e, payload: unknown) => {
      const value = parsed(setPolicySchema, payload)
      if (!value) return
      sessionManager.setPolicy(value.sessionId, value.policy)
    }
  )

  ipcMain.on(
    IpcChannels.hostVerifyRespond,
    (_e, payload: unknown) => {
      const value = parsed(hostVerifyRespondSchema, payload)
      if (!value) return
      sessionManager.respondHostVerify(value.requestId, value.ok)
    }
  )

  ipcMain.on(IpcChannels.termInput, (_e, payload: unknown) => {
    const value = parsed(termInputSchema, payload)
    if (!value) return
    sessionManager.write(value.sessionId, value.data)
  })

  ipcMain.on(
    IpcChannels.termResize,
    (_e, payload: unknown) => {
      const value = parsed(termResizeSchema, payload)
      if (!value) return
      sessionManager.resize(value.sessionId, value.cols, value.rows)
    }
  )

  sessionManager.on('output', (sessionId: string, data: Buffer) => {
    getWindow()?.webContents.send(IpcChannels.termOutput, {
      sessionId,
      data: data.toString('utf8'),
    })
  })

  sessionManager.on('status', (summary) => {
    getWindow()?.webContents.send(IpcChannels.sessionStatus, summary)
  })

  sessionManager.on('agent', (event: AgentEvent) => {
    getWindow()?.webContents.send(IpcChannels.agentEvent, event)
  })

  sessionManager.on('hostVerify', (req: HostVerifyRequest) => {
    getWindow()?.webContents.send(IpcChannels.hostVerify, req)
  })

  ipcMain.handle(IpcChannels.sessionRename, async (_e, payload: unknown) => {
    const request: RenameSessionRequest = required(renameSessionRequestSchema, payload)
    return sessionManager.rename(request.sessionId, request.title)
  })

  ipcMain.handle(IpcChannels.sessionDuplicate, async (_e, payload: unknown) => {
    const request: DuplicateSessionRequest = required(duplicateSessionRequestSchema, payload)
    return sessionManager.duplicate(request.sessionId, request.title)
  })

  ipcMain.handle(IpcChannels.sessionCloseMany, async (_e, payload: unknown) => {
    const request: CloseSessionsRequest = required(closeSessionsRequestSchema, payload)
    sessionManager.closeMany(request.sessionIds)
  })

  sessionManager.on('hostVerifyClosed', (event: HostVerifyClosed) => {
    getWindow()?.webContents.send(IpcChannels.hostVerifyClosed, event)
  })
}
