import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SSHClient,
  ContextBuffer,
  SpotShellAgent,
  AgentCancelledError,
  SSHCommandExecutor,
  ShellIntegration,
  SHELL_INTEGRATION_SNIPPET,
  resolveContextWindow,
  buildKnowledgeAssemblyParts,
  scanKnowledgeSecrets,
  applyPendingRevision,
  buildProposalUnifiedDiff,
  createKnowledgeProposal,
  createPendingRevisionApply,
  detectRevisionUpdates,
  dismissRevisionUpdate,
  editKnowledgeProposal,
  ensureActivePin,
  formatVersionSwitchContextEvent,
  hostNotesObjectId,
  isHostNotesObjectId,
  prepareAcceptKnowledgeProposal,
  proposedFileContents,
  rebaseKnowledgeProposal,
  repairMissingSpaceFrontmatter,
  cancelKnowledgeProposal,
  type ActiveRevisionPin,
  type AgentConfig,
  type AgentContext,
  type AgentHistory,
  type AgentRuntime,
  type SSHExecutor,
  type SSHConnectionConfig,
  type RiskLevel,
  type SSHToolExtras,
  type KnowledgeChangeProposalRequest,
  type KnowledgeChangeProposal,
  type KnowledgeTargetQuestion,
  type DynamicModuleSelection,
  type KnowledgeHarness,
  type KnowledgeProvenanceRecord,
  type ContextAssemblyResult,
  type LatestRevisionSnapshot,
  type VersionSwitchEvent,
} from '@spotshell/core'
import type {
  AgentChatQuote,
  AgentEvent,
  ApprovalResponseResult,
  ConnectRequest,
  ContextBoundaryReason,
  ContextUsageSnapshot,
  HostVerifyRequest,
  HostVerifyClosed,
  SessionApplyRevisionRequest,
  SessionKeepRevisionRequest,
  SessionSummary,
  ExecPolicy,
} from '../shared/ipc-types'
import { toContextUsageSnapshot } from '../shared/contextUsage'
import {
  formatUserQuotesForAgent,
  MAX_PENDING_REFERENCES,
  MAX_PENDING_REFERENCE_TOTAL_CHARS,
  MAX_TOOL_REFERENCE_CHARS,
  type MessageReferenceSnapshot,
} from '../shared/messageReference'
import {
  advanceEpoch,
  createInitialEpochState,
  markEpochActivity,
  shouldOpenNewEpochOnEnvironmentChange,
  type ContextEpochState,
} from './contextEpoch'
import {
  assessNewContextGate,
  isLateEpochEvent,
  RUNNING_COMMAND_BLOCKS_ENVIRONMENT_SWITCH,
  RUNNING_COMMAND_BLOCKS_NEW_CONTEXT,
} from './contextBusyGate'
import { PolicyExecutor } from './PolicyExecutor'
import type { AuditLog } from './AuditLog'
import type { KnownHostsStore } from './KnownHostsStore'
import { PendingConfirms } from './PendingConfirms'
import { PendingChoices, type PendingChoiceStatus } from './PendingChoices'
import { SerialQueue } from './SerialQueue'
import { requireSshAgentSocket } from './sshAgent'
import { resolveConnectionAuthentication } from './connectionAuth'
import { classifyConnectionError } from './connectionError'

const SHELL_BOOTSTRAP_CLEAR_IDLE_MS = 100

interface LiveSession {
  id: string
  title: string
  status: SessionSummary['status']
  hostId?: string
  environmentId?: string
  environmentSource: SessionSummary['environmentSource']
  pinnedModuleIds: Set<string>
  dynamicModuleIds: Set<string>
  /**
   * Agent-active revisions for the current environment, Host Notes, and loaded modules.
   * Saves raise update-available; apply switches pins from the next request.
   */
  activeRevisions: Map<string, ActiveRevisionPin>
  /** Dismissed "keep current version" keys until that concrete latest changes. */
  dismissedRevisionUpdates: Set<string>
  /** Version switch events waiting to enter the next model context assembly. */
  pendingVersionSwitchEvents: VersionSwitchEvent[]
  /** Cached update-available rows from the last async refresh. */
  revisionUpdatesAvailable: SessionSummary['revisionUpdatesAvailable']
  /** Backend Agent context segment; independent of visible Chat messages. */
  epoch: ContextEpochState
  errorMessage?: string
  errorKind?: SessionSummary['errorKind']
  /** Readable rejection reason that replaces ssh2's generic handshake error. */
  pendingVerifyError?: { attemptId: number; message: string }
  /** Connect credentials kept in RAM only for reconnect (never written to disk). */
  lastConnect: ConnectRequest
  client: SSHClient
  context: ContextBuffer
  agent: AgentRuntime | null
  executor: SSHCommandExecutor | null
  agentExecutor: SSHExecutor | null
  agentExtras: SSHToolExtras | null
  modelConfigured: boolean
  hasPendingModelRefresh: boolean
  pendingModelConfig: AgentConfig | null
  policy: ExecPolicy
  chatAbort: AbortController | null
  /**
   * Epoch id for the in-flight agent turn (generation / knowledge tools).
   * Late events keep this stamp so they only update the original visible segment.
   */
  activeTurnEpoch: number | null
  /** Count of agent-side SSH exec channels currently running after approval. */
  agentExecInFlight: number
  shell: ShellIntegration
  /** Pending one-shot remote redraw after the first shell integration prompt. */
  shellBootstrapClearPending: boolean
  shellBootstrapClearTimer: ReturnType<typeof setTimeout> | null
  attemptId: number
  /** Active read-only knowledge harness for the current agent turn. */
  knowledgeHarness: KnowledgeHarness | null
  /** Latest ContextAssembler usage snapshot for the Chat meter. */
  contextUsage?: ContextUsageSnapshot
}

export type AgentFactory = (
  config: AgentConfig,
  executor: SSHExecutor,
  extras?: SSHToolExtras
) => AgentRuntime

const createDefaultAgent: AgentFactory = (config, executor, extras) =>
  new SpotShellAgent(config, executor, extras)

export interface SessionEnvironmentAccess {
  getBoundEnvironmentId(hostId: string): string | undefined
  environmentExists(environmentId: string): Promise<boolean>
  setBoundEnvironmentId(hostId: string, environmentId: string | undefined): void
  /** Optional display name for visible context-boundary labels. */
  getEnvironmentName?(environmentId: string): string | undefined | Promise<string | undefined>
}

const noEnvironmentAccess: SessionEnvironmentAccess = {
  getBoundEnvironmentId: () => undefined,
  environmentExists: async () => false,
  setBoundEnvironmentId: () => undefined,
}

export interface SessionKnowledgeAccess {
  isAuthorizedCandidate(environmentId: string | undefined, moduleId: string): Promise<boolean>
  /**
   * Modules the session may target with an AI knowledge proposal (fixed /
   * pinned / dynamic / authorized candidates). Not a write ACL.
   */
  isProposalAllowedModule?(
    environmentId: string | undefined,
    moduleId: string,
    sessionModuleIds?: readonly string[],
  ): Promise<boolean>
  buildHarness?(scope: {
    environmentId?: string
    pinnedModuleIds: readonly string[]
    dynamicModuleIds: readonly string[]
    activeRevisions?: ReadonlyMap<string, number>
  }): Promise<KnowledgeHarness>
  /** Latest published revision for update-available checks. */
  resolveLatestPublished?(id: string): Promise<{
    id: string
    name: string
    kind: 'environment' | 'knowledge'
    revision: number
    contentHash: string
  } | undefined>
  readPublishedRevisionFiles?(
    id: string,
    revision?: number,
  ): Promise<Array<{ relativePath: string; content: string; contentHash: string }>>
  applyAcceptedKnowledgeProposal?(
    id: string,
    options: {
      expectedKind: 'environment' | 'knowledge'
      baseRevision: number
      baseContentHash: string
      files: readonly { relativePath: string; content: string }[]
    },
  ): Promise<{ revision: number; contentHash: string; origin?: string }>
}

export interface KnowledgeProposalResponse {
  accepted: boolean
  status?: 'approved' | 'rejected' | 'cancelled' | 'expired' | 'conflict' | 'validation-failed'
  message?: string
  proposal?: KnowledgeChangeProposal
  unifiedDiff?: string
}

const noSessionKnowledgeAccess: SessionKnowledgeAccess = {
  isAuthorizedCandidate: async () => false,
}

/** Choice outcomes reuse the approval card's terminal states in the renderer. */
function toApprovalStatus(
  status: PendingChoiceStatus
): NonNullable<ApprovalResponseResult['status']> {
  if (status === 'answered') return 'approved'
  if (status === 'dismissed') return 'rejected'
  return status
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, LiveSession>()
  private confirms = new PendingConfirms(5 * 60_000)
  private noteConfirms = new PendingConfirms(5 * 60_000)
  private knowledgeProposalConfirms = new PendingConfirms(5 * 60_000)
  /** Landing-place questions wait longer than approvals: the user has to think. */
  private knowledgeTargetChoices = new PendingChoices(10 * 60_000)
  private pendingKnowledgeProposals = new Map<string, {
    sessionId: string
    epoch: number
    proposal: KnowledgeChangeProposal
  }>()
  /** In-flight accepts: cancel must not steal these mid-write. */
  private applyingKnowledgeProposals = new Set<string>()
  private hostVerifies = new PendingConfirms(2 * 60_000)
  private chatQueue = new SerialQueue()

  constructor(
    private readonly getAgentConfig: () => AgentConfig | null,
    private readonly knownHosts: KnownHostsStore,
    private readonly audit: AuditLog,
    private readonly getHostNotes: (hostId: string) => string | undefined,
    private readonly isShellIntegrationEnabled: () => boolean,
    private readonly appendHostNote: (hostId: string, note: string) => string,
    private readonly createSshClient: () => SSHClient = () => new SSHClient(),
    private readonly createAgent: AgentFactory = createDefaultAgent,
    private readonly environmentAccess: SessionEnvironmentAccess = noEnvironmentAccess,
    private readonly knowledgeAccess: SessionKnowledgeAccess = noSessionKnowledgeAccess,
    private readonly setHostNotes: (
      hostId: string,
      notes: string,
    ) => string = () => '主机备注保存不可用',
  ) {
    super()
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => this.toSummary(s))
  }

  async connect(req: ConnectRequest): Promise<SessionSummary> {
    const { environmentId, environmentSource } = await this.resolveInitialEnvironment(req.hostId)
    return this.createSession(
      req,
      'ask',
      environmentId,
      environmentSource,
    )
  }

  private async resolveInitialEnvironment(hostId?: string): Promise<{
    environmentId?: string
    environmentSource: SessionSummary['environmentSource']
  }> {
    const environmentId = hostId
      ? this.environmentAccess.getBoundEnvironmentId(hostId)
      : undefined
    if (environmentId && !await this.environmentAccess.environmentExists(environmentId)) {
      throw new Error(
        `Bound environment profile not found: ${environmentId}. Update or clear the saved host binding.`,
      )
    }
    return {
      environmentId,
      environmentSource: environmentId ? 'host-binding' : 'none',
    }
  }

  activeConnectionCount(): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.status === 'connecting' || session.status === 'ready') count += 1
    }
    return count
  }

  async selectEnvironment(
    sessionId: string,
    environmentId: string | undefined,
    persistForHost = false,
  ): Promise<SessionSummary> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.assertNoRunningCommand(session, RUNNING_COMMAND_BLOCKS_ENVIRONMENT_SWITCH)
    if (environmentId && !await this.environmentAccess.environmentExists(environmentId)) {
      throw new Error(`Environment profile not found: ${environmentId}`)
    }
    if (persistForHost && !session.hostId) {
      throw new Error('Save this quick connection as a host before setting an automatic environment')
    }
    if (persistForHost) {
      this.environmentAccess.setBoundEnvironmentId(session.hostId!, environmentId)
    }

    const environmentChanged = session.environmentId !== environmentId
    if (environmentChanged) {
      if (shouldOpenNewEpochOnEnvironmentChange(session.epoch, true)) {
        // Cancel generation / pending approvals before opening the new segment.
        this.settleCancellableWork(session.id)
        this.assertNoRunningCommand(session, RUNNING_COMMAND_BLOCKS_ENVIRONMENT_SWITCH)
        await this.openNewContextEpoch(session, 'environment-switch', {
          fromEnvironmentId: session.environmentId,
          toEnvironmentId: environmentId,
          clearPinnedModules: true,
        })
      } else {
        // Empty epoch: swap environment baseline without a visible boundary,
        // but still drop old-env knowledge and AI-only terminal injection.
        this.settleCancellableWork(session.id)
        this.resetEphemeralAgentState(session, { clearPinnedModules: true })
      }
      // Drop the previous environment pin so the next harness build pins the new one.
      for (const [objectId, pin] of [...session.activeRevisions.entries()]) {
        if (pin.kind === 'environment') session.activeRevisions.delete(objectId)
      }
    }
    session.environmentId = environmentId
    session.environmentSource = environmentId
      ? persistForHost ? 'host-binding' : 'session'
      : 'none'
    this.refreshSessionContextUsage(session)
    this.emitStatus(session)
    return this.toSummary(session)
  }

  async loadKnowledgeModule(sessionId: string, moduleId: string): Promise<SessionSummary> {
    const session = this.getSession(sessionId)
    if (session.pinnedModuleIds.has(moduleId) || session.dynamicModuleIds.has(moduleId)) {
      return this.toSummary(session)
    }
    await this.assertAuthorizedCandidate(session, moduleId)
    session.dynamicModuleIds.add(moduleId)
    this.markSessionEpochActivity(session)
    this.emitStatus(session)
    return this.toSummary(session)
  }

  async pinKnowledgeModule(sessionId: string, moduleId: string): Promise<SessionSummary> {
    const session = this.getSession(sessionId)
    if (!session.dynamicModuleIds.has(moduleId) && !session.pinnedModuleIds.has(moduleId)) {
      await this.assertAuthorizedCandidate(session, moduleId)
    }
    session.dynamicModuleIds.delete(moduleId)
    session.pinnedModuleIds.add(moduleId)
    this.emitStatus(session)
    return this.toSummary(session)
  }

  unpinKnowledgeModule(sessionId: string, moduleId: string): SessionSummary {
    const session = this.getSession(sessionId)
    if (!session.pinnedModuleIds.delete(moduleId)) {
      throw new Error('Knowledge module is not pinned for this session')
    }
    this.emitStatus(session)
    return this.toSummary(session)
  }

  unloadKnowledgeModule(sessionId: string, moduleId: string): SessionSummary {
    const session = this.getSession(sessionId)
    if (!session.dynamicModuleIds.delete(moduleId)) {
      throw new Error('Knowledge module is not dynamically loaded for this session')
    }
    // Unload only affects future Agent context; completed answers and SSH work stay as-is.
    if (!session.pinnedModuleIds.has(moduleId)) {
      session.activeRevisions.delete(moduleId)
    }
    this.emitStatus(session)
    void this.refreshRevisionUpdates(session)
    return this.toSummary(session)
  }

  /**
   * Apply a confirmed new revision from the next Agent request.
   * Rejects stale confirmations when the target changed after the user reviewed it.
   */
  async applyKnowledgeRevision(request: SessionApplyRevisionRequest): Promise<SessionSummary> {
    const session = this.getSession(request.sessionId)
    const latest = await this.resolveLatestSnapshot(session, request.objectId)
    const pending = createPendingRevisionApply(
      {
        objectId: request.objectId,
        kind: latest?.kind ?? session.activeRevisions.get(request.objectId)?.kind ?? 'knowledge',
        name: latest?.name ?? session.activeRevisions.get(request.objectId)?.name ?? request.objectId,
        revision: request.targetRevision,
        contentHash: request.targetContentHash,
      },
      new Date().toISOString(),
    )
    const result = applyPendingRevision(session.activeRevisions, pending, latest)
    if (!result.ok) {
      if (result.reason === 'stale-target') {
        throw new Error(
          'The target revision changed after confirmation. Review the latest version and apply again.',
        )
      }
      if (result.reason === 'not-active') {
        throw new Error('That object is not active in the current Agent context')
      }
      throw new Error('Could not resolve the target revision to apply')
    }

    // Drop only this object's entry/guidance/search/body material; other objects stay.
    session.knowledgeHarness?.clearObjectMaterial(request.objectId)

    session.pendingVersionSwitchEvents.push(result.event)
    // Clear dismissals for this object so future updates can resurface.
    for (const key of [...session.dismissedRevisionUpdates]) {
      if (key.startsWith(`${request.objectId}@`)) {
        session.dismissedRevisionUpdates.delete(key)
      }
    }

    this.emitAgentEvent(session, {
      type: 'knowledge_revision_switch',
      objectId: result.event.objectId,
      kind: result.event.kind,
      name: result.event.name,
      fromRevision: result.event.fromRevision,
      fromContentHash: result.event.fromContentHash,
      toRevision: result.event.toRevision,
      toContentHash: result.event.toContentHash,
      appliedAt: result.event.appliedAt,
    })
    this.refreshSessionContextUsage(session)
    await this.refreshRevisionUpdates(session)
    this.emitStatus(session)
    return this.toSummary(session)
  }

  /** Keep the current Agent-active revision; hide this concrete latest until it changes. */
  async keepKnowledgeRevision(request: SessionKeepRevisionRequest): Promise<SessionSummary> {
    const session = this.getSession(request.sessionId)
    if (!session.activeRevisions.has(request.objectId)) {
      throw new Error('That object is not active in the current Agent context')
    }
    session.dismissedRevisionUpdates = dismissRevisionUpdate(session.dismissedRevisionUpdates, {
      objectId: request.objectId,
      latestRevision: request.latestRevision,
      latestContentHash: request.latestContentHash,
    })
    await this.refreshRevisionUpdates(session)
    this.emitStatus(session)
    return this.toSummary(session)
  }

  /**
   * Keep a dynamically selected module active for the current Agent context segment
   * and emit a visible auto-load event (module, reason, revision, load type).
   * Late selections (after a new epoch) only update the original visible transcript.
   */
  private applyDynamicModuleSelection(
    session: LiveSession,
    selection: DynamicModuleSelection,
  ): void {
    if (selection.loadType !== 'dynamic') return
    const eventEpoch = session.activeTurnEpoch ?? session.epoch.contextEpoch
    const late = isLateEpochEvent(eventEpoch, session.epoch.contextEpoch)
    const alreadyActive = session.dynamicModuleIds.has(selection.moduleId)
      || session.pinnedModuleIds.has(selection.moduleId)
    if (!late) {
      session.dynamicModuleIds.add(selection.moduleId)
      ensureActivePin(session.activeRevisions, {
        objectId: selection.moduleId,
        kind: 'knowledge',
        name: selection.moduleName,
        revision: selection.revision,
        contentHash: selection.contentHash,
      })
      this.markSessionEpochActivity(session)
    }
    this.emitAgentEvent(session, {
      type: 'knowledge_module_selected',
      selection: {
        moduleId: selection.moduleId,
        moduleName: selection.moduleName,
        revision: selection.revision,
        contentHash: selection.contentHash,
        reason: selection.reason,
        loadType: 'dynamic',
        ...(selection.scope ? { scope: selection.scope } : {}),
      },
    }, eventEpoch)
    if (!late && !alreadyActive) {
      this.emitStatus(session)
    }
  }

  rename(sessionId: string, title: string): SessionSummary {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    session.title = title.trim()
    this.emitStatus(session)
    return this.toSummary(session)
  }

  async duplicate(sessionId: string, title: string): Promise<SessionSummary> {
    const source = this.sessions.get(sessionId)
    if (!source) throw new Error(`Unknown session: ${sessionId}`)
    const { environmentId, environmentSource } = await this.resolveInitialEnvironment(source.hostId)
    return this.createSession(
      { ...source.lastConnect, title: title.trim() },
      source.policy,
      environmentId,
      environmentSource,
    )
  }

  closeMany(sessionIds: readonly string[]): void {
    for (const sessionId of new Set(sessionIds)) this.close(sessionId)
  }

  private createSession(
    req: ConnectRequest,
    policy: ExecPolicy,
    environmentId?: string,
    environmentSource: SessionSummary['environmentSource'] = 'none',
  ): SessionSummary {
    const id = crypto.randomUUID()
    const client = this.createSshClient()
    const context = new ContextBuffer({ maxSize: 50000, maxLines: 1000 })
    const title = req.title ?? `${req.username}@${req.host}`
    const session: LiveSession = {
      id,
      title,
      status: 'connecting',
      hostId: req.hostId,
      environmentId,
      environmentSource,
      pinnedModuleIds: new Set(),
      dynamicModuleIds: new Set(),
      activeRevisions: new Map(),
      dismissedRevisionUpdates: new Set(),
      pendingVersionSwitchEvents: [],
      revisionUpdatesAvailable: [],
      epoch: createInitialEpochState(),
      lastConnect: { ...req },
      client,
      context,
      agent: null,
      executor: null,
      agentExecutor: null,
      agentExtras: null,
      modelConfigured: Boolean(this.getAgentConfig()),
      hasPendingModelRefresh: false,
      pendingModelConfig: null,
      policy,
      chatAbort: null,
      activeTurnEpoch: null,
      agentExecInFlight: 0,
      shell: new ShellIntegration(),
      shellBootstrapClearPending: false,
      shellBootstrapClearTimer: null,
      attemptId: 1,
      knowledgeHarness: null,
      contextUsage: undefined,
    }
    this.sessions.set(id, session)
    this.emitStatus(session)

    void this.runConnectionAttempt(session, req, client, session.attemptId)
    return this.toSummary(session)
  }

  private async runConnectionAttempt(
    session: LiveSession,
    req: ConnectRequest,
    client: SSHClient,
    attemptId: number,
    savedHistory?: AgentHistory
  ): Promise<void> {
    try {
      await this.openShell(session, req, client, attemptId)
      if (savedHistory && this.isCurrentAttempt(session, client, attemptId)) {
        session.agent?.setHistory(savedHistory)
      }
    } catch (error) {
      if (!this.isCurrentAttempt(session, client, attemptId)) {
        this.disposeClient(client)
        return
      }
      this.cancelShellBootstrapClear(session)
      const pendingVerifyError = session.pendingVerifyError?.attemptId === attemptId
        ? session.pendingVerifyError.message
        : undefined
      const classified = classifyConnectionError(pendingVerifyError ?? error)
      session.status = 'error'
      session.errorKind = classified.kind
      session.errorMessage = classified.message
      session.pendingVerifyError = undefined
      this.emitStatus(session)
      this.disposeClient(client, true)
    }
  }

  async reconnect(sessionId: string): Promise<SessionSummary> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (!session.lastConnect) {
      throw new Error('No credentials available to reconnect')
    }

    const savedHistory = session.agent?.getHistory() ?? []
    this.rejectPendingForSession(sessionId)
    session.attemptId += 1
    this.teardownClient(session)

    const client = this.createSshClient()
    session.client = client
    session.agent = null
    session.executor = null
    session.status = 'connecting'
    session.errorMessage = undefined
    session.errorKind = undefined
    session.pendingVerifyError = undefined
    this.emitStatus(session)

    void this.runConnectionAttempt(
      session,
      session.lastConnect,
      client,
      session.attemptId,
      savedHistory
    )
    return this.toSummary(session)
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.cancelShellBootstrapClear(session)
    session.client.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
    this.sessions.get(sessionId)?.client.resizeWindow(Math.floor(cols), Math.floor(rows))
  }

  async chat(
    sessionId: string,
    message: string,
    quotes: readonly AgentChatQuote[] = [],
  ): Promise<string> {
    return this.chatQueue.run(sessionId, () => this.doChat(sessionId, message, quotes))
  }

  private async doChat(
    sessionId: string,
    message: string,
    quotes: readonly AgentChatQuote[] = [],
  ): Promise<string> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Unknown session: ${sessionId}`)
    if (!s.modelConfigured || !s.agent) {
      throw new Error('The current model provider has no API key configured.')
    }

    const userQuotes = this.prepareUserQuotes(s, quotes)

    this.markSessionEpochActivity(s)
    const turnEpoch = s.epoch.contextEpoch
    s.activeTurnEpoch = turnEpoch
    const ctx = this.buildAgentContext(s, userQuotes)

    if (this.knowledgeAccess.buildHarness) {
      s.knowledgeHarness = await this.knowledgeAccess.buildHarness({
        environmentId: s.environmentId,
        pinnedModuleIds: [...s.pinnedModuleIds],
        dynamicModuleIds: [...s.dynamicModuleIds],
        activeRevisions: this.activeRevisionMap(s),
      })
      this.pinHarnessObjects(s, s.knowledgeHarness)
    } else {
      s.knowledgeHarness = null
    }
    this.pinHostNotes(s)

    if (s.agent instanceof SpotShellAgent && s.knowledgeHarness) {
      const parts = await buildKnowledgeAssemblyParts(s.knowledgeHarness, {
        pinnedModuleIds: [...s.pinnedModuleIds],
      })
      const versionEvents = this.formatPendingVersionSwitchEvents(s)
      s.agent.setKnowledgeContext({
        ...parts,
        ...(versionEvents ? { reference: versionEvents } : {}),
      })
    } else if (s.agent instanceof SpotShellAgent) {
      const versionEvents = this.formatPendingVersionSwitchEvents(s)
      s.agent.setKnowledgeContext(versionEvents ? { reference: versionEvents } : {})
    }
    void this.refreshRevisionUpdates(s)

    const abort = new AbortController()
    s.chatAbort = abort
    this.emitAgentEvent(s, { type: 'status', text: 'thinking' }, turnEpoch)

    try {
      let provenance: KnowledgeProvenanceRecord[] | undefined
      const text = await s.agent.chatStream(message, ctx, {
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type === 'token') {
            this.emitAgentEvent(s, { type: 'token_delta', text: event.text }, turnEpoch)
          } else if (event.type === 'context_usage') {
            // Late usage from a closed epoch must not rewrite the new segment meter.
            if (!isLateEpochEvent(turnEpoch, s.epoch.contextEpoch)) {
              this.applyContextUsage(s, event.usage, turnEpoch)
            } else {
              this.emitAgentEvent(s, {
                type: 'context_usage',
                usage: toContextUsageSnapshot(event.usage),
              }, turnEpoch)
            }
          } else if (event.type === 'context_compaction') {
            this.emitAgentEvent(s, {
              type: 'context_compaction',
              summary: event.summary,
            }, turnEpoch)
          } else if (event.type === 'context_compaction_failed') {
            this.emitAgentEvent(s, {
              type: 'context_compaction_failed',
              error: event.error,
            }, turnEpoch)
          } else if (event.type === 'context_over_limit') {
            this.emitAgentEvent(s, {
              type: 'context_over_limit',
              reason: event.reason,
            }, turnEpoch)
          } else if (event.type === 'final' && event.provenance && event.provenance.length > 0) {
            provenance = event.provenance
          }
        },
      })
      // Version-switch context events only clear after a successful request.
      s.pendingVersionSwitchEvents = []
      // Prefer agent-emitted provenance; fall back to harness drain for fake agents.
      // Late finals still update the original visible transcript only.
      const finalProvenance = provenance
        ?? s.knowledgeHarness?.takeProvenance()
        ?? []
      this.emitAgentEvent(s, {
        type: 'final',
        text,
        ...(finalProvenance.length > 0 ? { provenance: finalProvenance } : {}),
      }, turnEpoch)
      // If the epoch advanced mid-turn, drop any history the agent may have written.
      if (isLateEpochEvent(turnEpoch, s.epoch.contextEpoch)) {
        s.agent.clearHistory()
      }
      return text
    } catch (err) {
      if (err instanceof AgentCancelledError || abort.signal.aborted) {
        this.emitAgentEvent(s, { type: 'cancelled' }, turnEpoch)
        return ''
      }
      const text = err instanceof Error ? err.message : String(err)
      this.emitAgentEvent(s, { type: 'error', text }, turnEpoch)
      throw err instanceof Error ? err : new Error(text)
    } finally {
      s.knowledgeHarness = null
      if (s.chatAbort === abort) s.chatAbort = null
      if (s.activeTurnEpoch === turnEpoch) s.activeTurnEpoch = null
      this.applyPendingModelRefresh(s)
    }
  }

  /** Apply model settings immediately when idle, or after the active turn finishes. */
  refreshAllAgentModels(): void {
    const config = this.getAgentConfig()
    for (const session of this.sessions.values()) {
      if (session.activeTurnEpoch !== null) {
        session.hasPendingModelRefresh = true
        session.pendingModelConfig = config
      } else {
        this.applyModelConfig(session, config)
      }
    }
  }

  private applyPendingModelRefresh(session: LiveSession): void {
    if (!session.hasPendingModelRefresh) return
    const config = session.pendingModelConfig
    session.hasPendingModelRefresh = false
    session.pendingModelConfig = null
    try {
      this.applyModelConfig(session, config)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emitAgentEvent(session, { type: 'error', text: message })
    }
  }

  private applyModelConfig(session: LiveSession, config: AgentConfig | null): void {
    session.modelConfigured = Boolean(config)
    if (!config) return
    if (!session.agentExecutor || !session.agentExtras) return

    if (!session.agent) {
      session.agent = this.createAgent(config, session.agentExecutor, session.agentExtras)
    } else if (session.agent instanceof SpotShellAgent) {
      session.agent.updateModel(config)
    } else {
      const history = session.agent.getHistory()
      const replacement = this.createAgent(config, session.agentExecutor, session.agentExtras)
      replacement.setHistory(history)
      session.agent = replacement
    }
    this.refreshSessionContextUsage(session, config)
  }

  /**
   * Recompute context usage for every live session after model/window settings change.
   */
  refreshAllContextUsage(): void {
    const config = this.getAgentConfig()
    for (const session of this.sessions.values()) {
      this.refreshSessionContextUsage(session, config)
    }
  }

  private refreshSessionContextUsage(
    session: LiveSession,
    config: AgentConfig | null = this.getAgentConfig(),
  ): void {
    const agent = session.agent
    if (!agent || !(agent instanceof SpotShellAgent) || !config) return
    const windowTokens = config.contextWindowTokens
      ?? resolveContextWindow({ model: config.model })
    agent.updateContextWindow(windowTokens)
    agent.updateAllowAutoContextCompaction(config.allowAutoContextCompaction !== false)
    void this.refreshSessionContextUsageAsync(session, agent)
  }

  private async refreshSessionContextUsageAsync(
    session: LiveSession,
    agent: SpotShellAgent,
  ): Promise<void> {
    if (this.knowledgeAccess.buildHarness) {
      try {
        const harness = await this.knowledgeAccess.buildHarness({
          environmentId: session.environmentId,
          pinnedModuleIds: [...session.pinnedModuleIds],
          dynamicModuleIds: [...session.dynamicModuleIds],
          activeRevisions: this.activeRevisionMap(session),
        })
        this.pinHarnessObjects(session, harness)
        this.pinHostNotes(session)
        const parts = await buildKnowledgeAssemblyParts(harness, {
          pinnedModuleIds: [...session.pinnedModuleIds],
        })
        agent.setKnowledgeContext(parts)
        await this.refreshRevisionUpdates(session)
      } catch {
        agent.setKnowledgeContext({})
      }
    }
    const assembly = agent.recomputeContextUsage(this.buildAgentContext(session))
    this.applyContextUsage(session, assembly)
  }

  /** Refresh update-available state after a repository publish, without requiring a chat turn. */
  async refreshKnowledgeRevisionUpdates(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (session) => {
      try {
        await this.refreshRevisionUpdates(session)
      } catch {
        // Publishing has already succeeded; a transient refresh failure must not undo it.
      }
    }))
  }

  private buildAgentContext(session: LiveSession, userQuotes?: string): AgentContext {
    const shell = session.shell
    return {
      terminalHistory: session.context.getRecentContext(4000),
      lastCommand: (shell.active ? shell.lastCommand : undefined) ?? session.context.getLastCommand(),
      lastError: session.context.getLastError(),
      currentDirectory: shell.active ? shell.cwd : undefined,
      lastExitCode: shell.active ? shell.lastExitCode : undefined,
      hostNotes: this.resolveActiveHostNotes(session),
      ...(userQuotes ? { userQuotes } : {}),
    }
  }

  private activeRevisionMap(session: LiveSession): Map<string, number> {
    const map = new Map<string, number>()
    for (const pin of session.activeRevisions.values()) {
      if (pin.kind === 'host-notes') continue
      map.set(pin.objectId, pin.revision)
    }
    return map
  }

  private pinHarnessObjects(session: LiveSession, harness: KnowledgeHarness): void {
    for (const object of harness.listSessionOverview().readable) {
      ensureActivePin(session.activeRevisions, {
        objectId: object.id,
        kind: object.kind,
        name: object.name,
        revision: object.revision,
        contentHash: object.contentHash,
      })
    }
  }

  private pinHostNotes(session: LiveSession): void {
    if (!session.hostId) return
    const notes = this.getHostNotes(session.hostId) ?? ''
    const objectId = hostNotesObjectId(session.hostId)
    const contentHash = hashText(notes)
    ensureActivePin(session.activeRevisions, {
      objectId,
      kind: 'host-notes',
      name: 'Host Notes',
      revision: 1,
      contentHash,
      contentSnapshot: notes,
    })
  }

  /**
   * Host Notes use the active pin snapshot. Latest disk notes enter only after apply.
   */
  private resolveActiveHostNotes(session: LiveSession): string | undefined {
    if (!session.hostId) return undefined
    const objectId = hostNotesObjectId(session.hostId)
    const pin = session.activeRevisions.get(objectId)
    if (pin?.contentSnapshot !== undefined) {
      return pin.contentSnapshot || undefined
    }
    const current = this.getHostNotes(session.hostId) ?? ''
    return current || undefined
  }

  private formatPendingVersionSwitchEvents(session: LiveSession): string | undefined {
    if (session.pendingVersionSwitchEvents.length === 0) return undefined
    return session.pendingVersionSwitchEvents
      .map((event) => formatVersionSwitchContextEvent(event))
      .join('\n\n')
  }

  private async resolveLatestSnapshot(
    session: LiveSession,
    objectId: string,
  ): Promise<LatestRevisionSnapshot | undefined> {
    if (isHostNotesObjectId(objectId)) {
      if (!session.hostId || hostNotesObjectId(session.hostId) !== objectId) return undefined
      const pin = session.activeRevisions.get(objectId)
      const notes = this.getHostNotes(session.hostId) ?? ''
      const contentHash = hashText(notes)
      if (!pin) {
        return {
          objectId,
          kind: 'host-notes',
          name: 'Host Notes',
          revision: 1,
          contentHash,
          contentSnapshot: notes,
        }
      }
      if (pin.contentHash === contentHash) {
        return {
          objectId,
          kind: 'host-notes',
          name: 'Host Notes',
          revision: pin.revision,
          contentHash,
          contentSnapshot: notes,
        }
      }
      return {
        objectId,
        kind: 'host-notes',
        name: 'Host Notes',
        revision: pin.revision + 1,
        contentHash,
        contentSnapshot: notes,
      }
    }

    const published = await this.knowledgeAccess.resolveLatestPublished?.(objectId)
    if (!published) return undefined
    return {
      objectId: published.id,
      kind: published.kind,
      name: published.name,
      revision: published.revision,
      contentHash: published.contentHash,
    }
  }

  private async refreshRevisionUpdates(session: LiveSession): Promise<void> {
    const snapshots: LatestRevisionSnapshot[] = []
    for (const pin of session.activeRevisions.values()) {
      const latest = await this.resolveLatestSnapshot(session, pin.objectId)
      if (latest) snapshots.push(latest)
    }
    session.revisionUpdatesAvailable = detectRevisionUpdates(
      session.activeRevisions,
      snapshots,
      session.dismissedRevisionUpdates,
    )
    this.emitStatus(session)
  }

  /**
   * Validate explicit old-context quotes, re-scan secrets, and freeze delivery text.
   * Visible transcript browsing never reaches this path without user selection.
   */
  private prepareUserQuotes(
    session: LiveSession,
    quotes: readonly AgentChatQuote[],
  ): string | undefined {
    if (quotes.length === 0) return undefined
    if (quotes.length > MAX_PENDING_REFERENCES) {
      throw new Error(`Too many quoted messages (max ${MAX_PENDING_REFERENCES})`)
    }

    const currentEpoch = session.epoch.contextEpoch
    const snapshots: MessageReferenceSnapshot[] = []
    let totalChars = 0

    for (const quote of quotes) {
      if (quote.sourceEpoch >= currentEpoch) {
        throw new Error('Quoted messages must come from an older agent context')
      }
      if (quote.role === 'tool' && quote.contentSnapshot.length > MAX_TOOL_REFERENCE_CHARS) {
        throw new Error(
          `Tool output quotes cannot exceed ${MAX_TOOL_REFERENCE_CHARS} characters; narrow the selection`,
        )
      }
      totalChars += quote.contentSnapshot.length
      if (totalChars > MAX_PENDING_REFERENCE_TOTAL_CHARS) {
        throw new Error('Quoted content exceeds the combined size limit; narrow the selection')
      }

      const scan = scanKnowledgeSecrets(quote.contentSnapshot)
      if (scan.status === 'blocked') {
        const rules = scan.findings
          .filter((finding) => finding.disposition === 'block')
          .map((finding) => finding.ruleId)
          .join(', ')
        throw new Error(`Quoted content blocked by secret scan (${rules || 'secret'})`)
      }

      snapshots.push({
        id: quote.sourceMessageId,
        sourceMessageId: quote.sourceMessageId,
        sourceEpoch: quote.sourceEpoch,
        role: quote.role,
        createdAt: quote.createdAt,
        referencedAt: new Date().toISOString(),
        contentSnapshot: quote.contentSnapshot,
        truncated: Boolean(quote.truncated),
        ...(quote.charRange ? { charRange: quote.charRange } : {}),
      })
    }

    return formatUserQuotesForAgent(snapshots)
  }

  private applyContextUsage(
    session: LiveSession,
    usage: ContextAssemblyResult,
    eventEpoch: number = session.epoch.contextEpoch,
  ): void {
    const snapshot = toContextUsageSnapshot(usage)
    // Late events must not overwrite the current epoch's meter.
    if (!isLateEpochEvent(eventEpoch, session.epoch.contextEpoch)) {
      session.contextUsage = snapshot
      this.emitStatus(session)
    }
    this.emitAgentEvent(session, { type: 'context_usage', usage: snapshot }, eventEpoch)
  }

  cancelChat(sessionId: string): void {
    this.settleCancellableWork(sessionId)
  }

  /** Abort generation/reads and cancel pending approvals for a session. */
  private settleCancellableWork(sessionOrId: LiveSession | string): void {
    const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id
    const session = typeof sessionOrId === 'string'
      ? this.sessions.get(sessionOrId)
      : sessionOrId
    session?.chatAbort?.abort()
    this.confirms.rejectForSession(sessionId)
    this.noteConfirms.rejectForSession(sessionId)
    this.knowledgeTargetChoices.rejectForSession(sessionId)
    this.cancelPendingKnowledgeProposals(sessionId)
  }

  private isCommandRunning(session: LiveSession): boolean {
    return session.shell.commandRunning || session.agentExecInFlight > 0
  }

  private assertNoRunningCommand(session: LiveSession, message: string): void {
    const gate = assessNewContextGate({
      terminalCommandRunning: session.shell.commandRunning,
      agentCommandRunning: session.agentExecInFlight > 0,
    })
    if (!gate.allowed) {
      throw new Error(message)
    }
  }

  private newContextBlockReason(session: LiveSession): string | undefined {
    const gate = assessNewContextGate({
      terminalCommandRunning: session.shell.commandRunning,
      agentCommandRunning: session.agentExecInFlight > 0,
    })
    return gate.allowed ? undefined : gate.message
  }

  setPolicy(sessionId: string, policy: ExecPolicy): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.policy = policy
    this.emitStatus(s)
  }

  /**
   * Clear backend Agent history only. Visible transcript is owned by the renderer.
   * Distinct from {@link startNewContext}, which keeps the visible transcript.
   */
  clearHistory(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    session.agent?.clearHistory()
    // Visible transcript is cleared by the renderer; epoch number is unchanged.
    session.epoch = {
      contextEpoch: session.epoch.contextEpoch,
      epochHasActivity: session.dynamicModuleIds.size > 0,
    }
    this.refreshSessionContextUsage(session)
    this.emitStatus(session)
  }

  /**
   * Open a new Agent context epoch without deleting the visible Chat transcript.
   * Cancels cancelable work first; blocks only while a remote command is running.
   * Clears ephemeral Agent state; keeps environment baseline, Host Notes, and config.
   */
  async startNewContext(sessionId: string): Promise<SessionSummary> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.assertNoRunningCommand(session, RUNNING_COMMAND_BLOCKS_NEW_CONTEXT)
    // Deterministic pre-settlement: stop generation/reads and cancel pending approvals.
    this.settleCancellableWork(session.id)
    // Re-check after settle: an approved exec may have committed during the wait.
    this.assertNoRunningCommand(session, RUNNING_COMMAND_BLOCKS_NEW_CONTEXT)
    await this.openNewContextEpoch(session, 'user', {
      clearPinnedModules: false,
    })
    this.refreshSessionContextUsage(session)
    this.emitStatus(session)
    return this.toSummary(session)
  }

  private markSessionEpochActivity(session: LiveSession): void {
    session.epoch = markEpochActivity(session.epoch)
  }

  private async resolveEnvironmentName(environmentId: string | undefined): Promise<string | undefined> {
    if (!environmentId) return undefined
    const resolved = await this.environmentAccess.getEnvironmentName?.(environmentId)
    return resolved ?? environmentId
  }

  /** Clear Agent-only ephemeral state without advancing the epoch. */
  private resetEphemeralAgentState(
    session: LiveSession,
    options: { clearPinnedModules: boolean },
  ): void {
    session.agent?.clearHistory()
    session.dynamicModuleIds.clear()
    if (options.clearPinnedModules) {
      session.pinnedModuleIds.clear()
      // Environment switch drops module pins for the old environment baseline.
      for (const [objectId, pin] of [...session.activeRevisions.entries()]) {
        if (pin.kind === 'knowledge') session.activeRevisions.delete(objectId)
      }
    } else {
      // New context clears dynamic modules only; drop pins for modules no longer loaded.
      for (const [objectId, pin] of [...session.activeRevisions.entries()]) {
        if (pin.kind !== 'knowledge') continue
        if (session.pinnedModuleIds.has(objectId)) continue
        session.activeRevisions.delete(objectId)
      }
    }
    session.knowledgeHarness = null
    session.context.clear()
    session.shell.resetAgentEphemeralContext()
  }

  private async openNewContextEpoch(
    session: LiveSession,
    reason: ContextBoundaryReason,
    options: {
      fromEnvironmentId?: string
      toEnvironmentId?: string
      clearPinnedModules: boolean
    },
  ): Promise<void> {
    const fromEnvironmentId = options.fromEnvironmentId
    const toEnvironmentId = options.toEnvironmentId
    const [fromEnvironmentName, toEnvironmentName] = await Promise.all([
      this.resolveEnvironmentName(fromEnvironmentId),
      this.resolveEnvironmentName(toEnvironmentId),
    ])
    const { state, boundary } = advanceEpoch(session.epoch, reason, {
      fromEnvironmentId,
      fromEnvironmentName,
      toEnvironmentId,
      toEnvironmentName,
    })
    session.epoch = state
    this.resetEphemeralAgentState(session, {
      clearPinnedModules: options.clearPinnedModules,
    })

    this.emitAgentEvent(session, {
      type: 'context_boundary',
      ...boundary,
    }, boundary.epoch)
  }

  respondConfirm(requestId: string, ok: boolean): ApprovalResponseResult {
    return this.confirms.respondWithStatus(requestId, ok)
  }

  respondNoteProposal(requestId: string, ok: boolean): ApprovalResponseResult {
    return this.noteConfirms.respondWithStatus(requestId, ok)
  }

  /**
   * Approve/reject a full knowledge change proposal. Edits are applied before accept.
   * Stale-base conflicts leave the wait open and return status `conflict`.
   */
  async respondKnowledgeProposal(
    requestId: string,
    request: {
      ok: boolean
      reason?: string
      terminalEvidence?: string
      files?: Array<{ relativePath: string; before: string; after: string }>
      promoteToGuidance?: boolean
    },
  ): Promise<KnowledgeProposalResponse> {
    const pending = this.pendingKnowledgeProposals.get(requestId)
    if (!pending) {
      return {
        accepted: false,
        status: this.knowledgeProposalConfirms.respondWithStatus(requestId, false).status,
      }
    }

    if (!request.ok) {
      const rejected = {
        ...pending.proposal,
        status: 'rejected' as const,
      }
      const settled = this.knowledgeProposalConfirms.respondWithStatus(requestId, false)
      this.pendingKnowledgeProposals.delete(requestId)
      return {
        accepted: settled.accepted,
        status: settled.status,
        proposal: rejected,
        unifiedDiff: buildProposalUnifiedDiff(rejected),
      }
    }

    let proposal = pending.proposal
    if (
      request.reason !== undefined
      || request.terminalEvidence !== undefined
      || request.files !== undefined
      || request.promoteToGuidance !== undefined
    ) {
      const edited = editKnowledgeProposal(proposal, {
        reason: request.reason,
        terminalEvidence: request.terminalEvidence,
        files: request.files?.map((file) => (
          file.relativePath === 'SPACE.md'
            ? { ...file, after: repairMissingSpaceFrontmatter(file.before, file.after) }
            : file
        )),
        promoteToGuidance: request.promoteToGuidance,
      })
      if (!edited.ok) {
        return {
          accepted: false,
          status: 'validation-failed',
          message: edited.error,
          proposal,
          unifiedDiff: buildProposalUnifiedDiff(proposal),
        }
      }
      proposal = edited.proposal
      this.pendingKnowledgeProposals.set(requestId, { ...pending, proposal })
    }

    const base = await this.resolveProposalBase(proposal)
    if (!base) {
      return {
        accepted: false,
        status: 'validation-failed',
        message: 'Proposal target is no longer available',
        proposal,
        unifiedDiff: buildProposalUnifiedDiff(proposal),
      }
    }

    if (this.applyingKnowledgeProposals.has(requestId)) {
      return {
        accepted: false,
        status: 'validation-failed',
        message: 'Proposal accept is already in progress',
        proposal,
        unifiedDiff: buildProposalUnifiedDiff(proposal),
      }
    }

    let candidate = proposal
    if (
      base.revision !== proposal.baseRevision
      || base.contentHash !== proposal.baseContentHash
    ) {
      const rebased = await this.rebaseProposalOntoCurrentBase(proposal)
      if (!rebased.ok) {
        this.pendingKnowledgeProposals.set(requestId, { ...pending, proposal: rebased.proposal })
        this.emitAgent({
          type: 'knowledge_proposal',
          sessionId: pending.sessionId,
          epoch: pending.epoch,
          requestId,
          proposal: rebased.proposal,
          unifiedDiff: buildProposalUnifiedDiff(rebased.proposal),
        })
        return {
          accepted: false,
          status: 'conflict',
          message: rebased.error,
          proposal: rebased.proposal,
          unifiedDiff: buildProposalUnifiedDiff(rebased.proposal),
        }
      }
      candidate = rebased.proposal
      this.pendingKnowledgeProposals.set(requestId, { ...pending, proposal: candidate })
      // Require an explicit second accept after rebase so the user re-reviews the new base.
      this.emitAgent({
        type: 'knowledge_proposal',
        sessionId: pending.sessionId,
        epoch: pending.epoch,
        requestId,
        proposal: candidate,
        unifiedDiff: buildProposalUnifiedDiff(candidate),
      })
      return {
        accepted: false,
        status: 'conflict',
        message: 'Target base changed; proposal rebased for re-review. Accept again after reviewing the new diff.',
        proposal: candidate,
        unifiedDiff: buildProposalUnifiedDiff(candidate),
      }
    }

    const prepared = prepareAcceptKnowledgeProposal(candidate, base)
    if (!prepared.ok) {
      this.pendingKnowledgeProposals.set(requestId, { ...pending, proposal: prepared.proposal })
      this.emitAgent({
        type: 'knowledge_proposal',
        sessionId: pending.sessionId,
        epoch: pending.epoch,
        requestId,
        proposal: prepared.proposal,
        unifiedDiff: buildProposalUnifiedDiff(prepared.proposal),
      })
      return {
        accepted: false,
        status: prepared.reason === 'stale' ? 'conflict' : 'validation-failed',
        message: prepared.error,
        proposal: prepared.proposal,
        unifiedDiff: buildProposalUnifiedDiff(prepared.proposal),
      }
    }

    // Hold cancel at bay while writing; settle only after apply succeeds.
    this.applyingKnowledgeProposals.add(requestId)
    try {
      const message = await this.applyKnowledgeProposal(prepared.proposal)
      const approved = {
        ...prepared.proposal,
        status: 'approved' as const,
      }
      const settled = this.knowledgeProposalConfirms.respondWithStatus(requestId, true)
      this.pendingKnowledgeProposals.delete(requestId)
      return {
        accepted: settled.accepted,
        status: settled.accepted ? 'approved' : settled.status,
        message: settled.accepted
          ? message
          : 'Proposal write completed but confirm was already resolved',
        proposal: approved,
        unifiedDiff: buildProposalUnifiedDiff(approved),
      }
    } catch (error) {
      const failed = {
        ...prepared.proposal,
        status: 'validation-failed' as const,
        validationError: error instanceof Error ? error.message : String(error),
      }
      this.pendingKnowledgeProposals.set(requestId, { ...pending, proposal: failed })
      return {
        accepted: false,
        status: 'validation-failed',
        message: failed.validationError,
        proposal: failed,
        unifiedDiff: buildProposalUnifiedDiff(failed),
      }
    } finally {
      this.applyingKnowledgeProposals.delete(requestId)
    }
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.rejectPendingForSession(sessionId)
    s.attemptId += 1
    this.teardownClient(s)
    // Drop credentials when the tab is closed (never write password to disk)
    s.lastConnect = { host: '', port: 22, username: '' }
    this.sessions.delete(sessionId)
    // Do not emit status after delete — renderer removes the tab via close IPC,
    // and a late status event would re-add a ghost disconnected session.
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
    }
  }

  private async openShell(
    session: LiveSession,
    req: ConnectRequest,
    client: SSHClient,
    attemptId: number
  ): Promise<void> {
    const { id, context } = session
    session.shell = new ShellIntegration()
    const isCurrentClient = (): boolean => this.isCurrentAttempt(session, client, attemptId)

    const authentication = resolveConnectionAuthentication(
      req,
      (keyPath) => this.readPrivateKey(keyPath),
      requireSshAgentSocket
    )

    const config: SSHConnectionConfig = {
      host: req.host,
      port: req.port,
      username: req.username,
      ...authentication,
      hostVerifier: (info) => this.verifyHostKey(
        session,
        req,
        info.fingerprint,
        client,
        attemptId
      ),
    }

    const onClientError = (err: Error): void => {
      if (!isCurrentClient()) return
      this.cancelShellBootstrapClear(session)
      if (session.status === 'ready') {
        const classified = classifyConnectionError(err)
        session.status = 'error'
        session.errorKind = classified.kind
        session.errorMessage = classified.message
        this.emitStatus(session)
      }
    }

    client.on('error', onClientError)
    const onClientClose = (): void => {
      if (!isCurrentClient()) return
      this.cancelShellBootstrapClear(session)
      if (session.status === 'ready') {
        session.status = 'disconnected'
        this.emitStatus(session)
      }
    }
    client.on('close', onClientClose)
    client.on('end', onClientClose)

    await client.connect(config)
    if (!isCurrentClient()) {
      this.disposeClient(client)
      return
    }
    const stream = await client.requestShell(120, 30)
    if (!isCurrentClient()) {
      this.disposeClient(client)
      return
    }
    session.executor = new SSHCommandExecutor(client, stream)

    const agentConfig = this.getAgentConfig()
    {
      const policyExec = new PolicyExecutor(session.executor, {
        getPolicy: () => session.policy,
        requestConfirm: (command, risk) => this.requestConfirm(id, command, risk),
        onAgentCommandRunning: (running) => {
          session.agentExecInFlight = Math.max(0, session.agentExecInFlight + (running ? 1 : -1))
          this.emitStatus(session)
        },
        onTool: (phase, name, command, output, meta) => {
          const eventEpoch = session.activeTurnEpoch ?? session.epoch.contextEpoch
          if (phase === 'start') {
            this.emitAgentEvent(session, {
              type: 'tool_start',
              name,
              input: { command },
            }, eventEpoch)
          } else {
            this.emitAgentEvent(session, {
              type: 'tool_end',
              name,
              output: output ?? '',
              meta,
            }, eventEpoch)
          }
        },
        audit: (record) => this.audit.append({
          ...record,
          sessionId: id,
          host: session.lastConnect.host,
        }),
      })
      const hostId = session.hostId
      const extras: SSHToolExtras = {
        knowledge: {
          getHarness: () => session.knowledgeHarness ?? undefined,
          onModuleSelected: (selection) => {
            this.applyDynamicModuleSelection(session, selection)
          },
        },
      }
      if (hostId) {
        extras.proposeHostNote = (note) => this.requestNoteProposal(session, hostId, note)
      }
      if (hostId || this.knowledgeAccess.applyAcceptedKnowledgeProposal) {
        extras.proposeKnowledgeChange = (request) =>
          this.requestKnowledgeProposal(session, request)
        // Offered alongside the proposal tool: asking where to write is only
        // meaningful when the model can actually write somewhere.
        extras.askKnowledgeTarget = (question) =>
          this.requestKnowledgeTarget(session, question)
      }
      session.agentExecutor = policyExec
      session.agentExtras = extras
      session.modelConfigured = Boolean(agentConfig)
      session.agent = agentConfig ? this.createAgent(agentConfig, policyExec, extras) : null
    }

    this.cancelShellBootstrapClear(session)
    const shellIntegration = this.isShellIntegrationEnabled()

    stream.on('data', (data: Buffer) => {
      if (!isCurrentClient()) return
      const wasRunning = session.shell.commandRunning
      session.shell.feed(data)
      if (wasRunning !== session.shell.commandRunning) {
        this.emitStatus(session)
      }
      void context.append(data)
      this.emit('output', id, data)
      if (shellIntegration && session.shell.active && session.shellBootstrapClearPending) {
        this.scheduleShellBootstrapClear(session, client, isCurrentClient)
      }
    })

    stream.stderr?.on('data', (data: Buffer) => {
      if (!isCurrentClient()) return
      void context.append(data)
      // stderr is not the injection-echo path; never buffer it in the filter.
      this.emit('output', id, data)
    })

    stream.on('close', () => {
      if (!isCurrentClient()) return
      this.cancelShellBootstrapClear(session)
      if (session.status === 'ready') {
        session.status = 'disconnected'
        this.emitStatus(session)
      }
    })

    session.status = 'ready'
    session.errorMessage = undefined
    session.errorKind = undefined
    session.pendingVerifyError = undefined
    // Keep latest credentials (password may have been supplied on first connect)
    session.lastConnect = { ...req }
    if (shellIntegration) {
      this.beginShellIntegrationInject(session, client, isCurrentClient)
    }
    this.emitStatus(session)
  }

  /** Install bash markers while keeping every bootstrap concern display-local. */
  private beginShellIntegrationInject(
    session: LiveSession,
    client: SSHClient,
    isCurrentClient: () => boolean,
  ): void {
    this.cancelShellBootstrapClear(session)
    session.shellBootstrapClearPending = true
    client.write(SHELL_INTEGRATION_SNIPPET)
  }

  private scheduleShellBootstrapClear(
    session: LiveSession,
    client: SSHClient,
    isCurrentClient: () => boolean,
  ): void {
    if (!session.shellBootstrapClearPending || !isCurrentClient()) return
    if (session.shellBootstrapClearTimer !== null) {
      clearTimeout(session.shellBootstrapClearTimer)
    }
    session.shellBootstrapClearTimer = setTimeout(() => {
      if (!isCurrentClient()) return
      session.shellBootstrapClearTimer = null
      if (!session.shellBootstrapClearPending || session.status !== 'ready') return
      session.shellBootstrapClearPending = false
      client.write('\x0c')
    }, SHELL_BOOTSTRAP_CLEAR_IDLE_MS)
  }

  private cancelShellBootstrapClear(session: LiveSession): void {
    session.shellBootstrapClearPending = false
    if (session.shellBootstrapClearTimer !== null) {
      clearTimeout(session.shellBootstrapClearTimer)
      session.shellBootstrapClearTimer = null
    }
  }

  private teardownClient(session: LiveSession): void {
    session.chatAbort?.abort()
    session.chatAbort = null
    this.cancelShellBootstrapClear(session)
    try {
      session.client.disconnect()
    } catch {
      try {
        session.client.destroy()
      } catch {
        // ignore
      }
    }
    session.executor = null
    session.agent = null
  }

  private async requestConfirm(sessionId: string, command: string, risk: RiskLevel): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    const eventEpoch = session?.activeTurnEpoch ?? session?.epoch.contextEpoch ?? 1
    const requestId = crypto.randomUUID()
    const promise = this.confirms.create(sessionId, requestId)
    const required: AgentEvent = {
      type: 'confirm_required',
      sessionId,
      epoch: eventEpoch,
      command,
      requestId,
      risk: risk === 'destructive' ? 'destructive' : 'write',
    }
    this.emitAgent(required)
    const outcome = await promise
    this.emitAgent({
      type: 'approval_resolved',
      sessionId,
      epoch: eventEpoch,
      requestId,
      status: outcome.status,
    })
    // Commit the exec gate immediately on approve so startNewContext cannot race
    // the gap between confirm settle and PolicyExecutor's inner.execute.
    if (outcome.ok) {
      const live = this.sessions.get(sessionId)
      if (live) {
        live.agentExecInFlight += 1
        this.emitStatus(live)
      }
    }
    return outcome.ok
  }

  private isCurrentAttempt(session: LiveSession, client: SSHClient, attemptId: number): boolean {
    return this.sessions.get(session.id) === session
      && session.client === client
      && session.attemptId === attemptId
  }

  private disposeClient(client: SSHClient, destroy = false): void {
    try {
      if (destroy) client.destroy()
      else client.disconnect()
    } catch {
      if (!destroy) {
        try {
          client.destroy()
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  private async requestNoteProposal(
    session: LiveSession,
    hostId: string,
    note: string
  ): Promise<string> {
    const live = this.sessions.get(session.id) ?? session
    const eventEpoch = live.activeTurnEpoch ?? live.epoch?.contextEpoch ?? 1
    const requestId = crypto.randomUUID()
    const promise = this.noteConfirms.create(session.id, requestId)
    this.emitAgent({
      type: 'note_proposal',
      sessionId: session.id,
      epoch: eventEpoch,
      requestId,
      note,
    })
    const outcome = await promise
    this.emitAgent({
      type: 'approval_resolved',
      sessionId: session.id,
      epoch: eventEpoch,
      requestId,
      status: outcome.status,
    })
    if (!outcome.ok) return '用户未确认，备注未保存'
    // Host notes are session-global; the proposal card still resolves with a terminal status.
    return this.appendHostNote(hostId, note)
  }

  /**
   * Ask the user where a knowledge change should land and block the tool call
   * until they answer. The returned string is the tool result the model sees, so
   * every terminal state has to tell the model what to do next.
   */
  private async requestKnowledgeTarget(
    session: LiveSession,
    question: KnowledgeTargetQuestion,
  ): Promise<string> {
    const candidates = question.candidates
    if (candidates.length === 0) return '没有可选落点，请先用知识目录工具确认可写对象'

    const live = this.sessions.get(session.id) ?? session
    const eventEpoch = live.activeTurnEpoch ?? live.epoch?.contextEpoch ?? 1
    const requestId = crypto.randomUUID()
    const promise = this.knowledgeTargetChoices.create(session.id, requestId, candidates.length)
    this.emitAgent({
      type: 'knowledge_target_question',
      sessionId: session.id,
      epoch: eventEpoch,
      requestId,
      question: question.question,
      candidates,
    })
    const outcome = await promise
    // Reuse the shared approval close path so the card resolves like every other one.
    this.emitAgent({
      type: 'approval_resolved',
      sessionId: session.id,
      epoch: eventEpoch,
      requestId,
      status: outcome.status === 'answered'
        ? 'approved'
        : outcome.status === 'dismissed'
          ? 'rejected'
          : outcome.status,
    })

    if (outcome.status === 'answered') {
      const chosen = candidates[outcome.optionIndex ?? 0]
      if (!chosen) return '选择结果无效，请重新询问用户'
      return `用户选择了落点 kind=${chosen.kind} targetId=${chosen.targetId}（${chosen.label}）。`
        + '现在可以用这个目标调用 propose_knowledge_change，不要改成别的目标。'
    }
    if (outcome.status === 'dismissed') {
      return '用户拒绝了全部候选落点。不要写入任何知识，直接向用户说明并结束。'
    }
    if (outcome.status === 'cancelled') {
      return '本轮已被取消，不要继续写入知识。'
    }
    return '用户未在时限内回复。停止本轮，不要写入任何知识，等待用户下一步指示。'
  }

  respondKnowledgeTarget(requestId: string, optionIndex: number | null): ApprovalResponseResult {
    const result = this.knowledgeTargetChoices.respond(requestId, optionIndex)
    if (!result.accepted) {
      return {
        accepted: false,
        ...(result.status ? { status: toApprovalStatus(result.status) } : {}),
      }
    }
    return { accepted: true, status: optionIndex === null ? 'rejected' : 'approved' }
  }

  private async requestKnowledgeProposal(
    session: LiveSession,
    request: KnowledgeChangeProposalRequest,
  ): Promise<string> {
    const live = this.sessions.get(session.id) ?? session
    const eventEpoch = live.activeTurnEpoch ?? live.epoch?.contextEpoch ?? 1
    const built = await this.buildKnowledgeProposal(live, request)
    if (!built.ok) return `提案失败: ${built.error}`

    const requestId = crypto.randomUUID()
    const proposal = { ...built.proposal, id: requestId }
    this.pendingKnowledgeProposals.set(requestId, {
      sessionId: session.id,
      epoch: eventEpoch,
      proposal,
    })
    const promise = this.knowledgeProposalConfirms.create(session.id, requestId)
    this.emitAgent({
      type: 'knowledge_proposal',
      sessionId: session.id,
      epoch: eventEpoch,
      requestId,
      proposal,
      unifiedDiff: buildProposalUnifiedDiff(proposal),
    })

    const outcome = await promise
    this.pendingKnowledgeProposals.delete(requestId)
    this.emitAgent({
      type: 'approval_resolved',
      sessionId: session.id,
      epoch: eventEpoch,
      requestId,
      status: outcome.status,
    })

    if (!outcome.ok) {
      if (outcome.status === 'cancelled') return '用户取消或上下文已切换，提案未写入'
      return '用户未确认，提案未写入'
    }
    // Write already happened in respondKnowledgeProposal before the wait settled.
    return `用户已接受提案并更新 ${proposal.targetName}`
  }

  private async buildKnowledgeProposal(
    session: LiveSession,
    request: KnowledgeChangeProposalRequest,
  ): Promise<{ ok: true; proposal: KnowledgeChangeProposal } | { ok: false; error: string }> {
    const sources = this.collectProposalSources(session)

    if (request.targetKind === 'host-notes') {
      if (!session.hostId || request.targetId !== session.hostId) {
        return { ok: false, error: 'Host Notes proposals must target the current saved host' }
      }
      const before = this.getHostNotes(session.hostId) ?? ''
      const file = request.files.find((entry) => entry.relativePath === 'notes')
      if (!file) return { ok: false, error: 'Host Notes proposal requires relativePath "notes"' }
      const after = file.after
      const pin = session.activeRevisions.get(hostNotesObjectId(session.hostId))
      return createKnowledgeProposal({
        id: 'pending',
        targetKind: 'host-notes',
        targetId: session.hostId,
        targetName: 'Host Notes',
        baseRevision: pin?.revision ?? 1,
        baseContentHash: hashText(before),
        files: [{ relativePath: 'notes', before, after }],
        reason: request.reason,
        terminalEvidence: request.terminalEvidence,
        knowledgeSources: sources,
        createdAt: new Date().toISOString(),
      })
    }

    if (!this.knowledgeAccess.readPublishedRevisionFiles || !this.knowledgeAccess.resolveLatestPublished) {
      return { ok: false, error: 'Knowledge proposal apply is not available' }
    }

    if (request.targetKind === 'environment') {
      if (!session.environmentId || request.targetId !== session.environmentId) {
        return { ok: false, error: 'Environment proposals must target the current session environment' }
      }
    } else if (request.targetKind === 'knowledge') {
      // Fixed (environment always / pinned), dynamic, and on-demand authorized modules
      // are all valid proposal targets. There is no separate "write permission".
      const sessionModuleIds = [
        ...new Set([
          ...(session.pinnedModuleIds ? [...session.pinnedModuleIds] : []),
          ...(session.dynamicModuleIds ? [...session.dynamicModuleIds] : []),
        ]),
      ]
      const harnessReadable = session.knowledgeHarness
        ?.listSessionOverview()
        .readable
        .some((object) => object.id === request.targetId && object.kind === 'knowledge')
        ?? false
      const allowed = harnessReadable
        || (this.knowledgeAccess.isProposalAllowedModule
          ? await this.knowledgeAccess.isProposalAllowedModule(
            session.environmentId,
            request.targetId,
            sessionModuleIds,
          )
          : (
            sessionModuleIds.includes(request.targetId)
            || await this.knowledgeAccess.isAuthorizedCandidate(
              session.environmentId,
              request.targetId,
            )
          ))
      if (!allowed) {
        return {
          ok: false,
          error:
            'Knowledge module is not in this session\'s readable set '
            + '(not fixed, pinned, dynamically loaded, or authorized on-demand). '
            + 'Load or authorize the module for reading first; Agent never has direct write access — '
            + 'accepted proposals are written by the app after user review.',
        }
      }
    }

    const latest = await this.knowledgeAccess.resolveLatestPublished(request.targetId)
    if (!latest) return { ok: false, error: 'Target object is not published' }
    if (latest.kind !== request.targetKind) {
      return { ok: false, error: `Target kind mismatch: expected ${request.targetKind}` }
    }

    // Prefer the session active pin so the proposal matches what the Agent actually read.
    const pin = session.activeRevisions.get(request.targetId)
    const baseRevision = pin?.revision ?? latest.revision
    const baseContentHash = pin?.contentHash ?? latest.contentHash
    if (pin && (pin.revision !== latest.revision || pin.contentHash !== latest.contentHash)) {
      // Allow propose against the active pin; accept will rebase if latest diverges.
    }

    const baseFiles = await this.knowledgeAccess.readPublishedRevisionFiles(
      request.targetId,
      baseRevision,
    )
    const beforeByPath = new Map(baseFiles.map((file) => [file.relativePath, file.content]))
    const files = request.files.map((file) => {
      const before = beforeByPath.get(file.relativePath) ?? ''
      const after = file.relativePath === 'SPACE.md'
        ? repairMissingSpaceFrontmatter(before, file.after)
        : file.after
      return { relativePath: file.relativePath, before, after }
    })

    return createKnowledgeProposal({
      id: 'pending',
      targetKind: request.targetKind,
      targetId: request.targetId,
      targetName: latest.name,
      baseRevision,
      baseContentHash,
      files,
      reason: request.reason,
      terminalEvidence: request.terminalEvidence,
      knowledgeSources: sources,
      createdAt: new Date().toISOString(),
    })
  }

  private collectProposalSources(session: LiveSession) {
    const harness = session.knowledgeHarness
    if (!harness) return []
    return harness.peekProvenance().map((record: KnowledgeProvenanceRecord) => ({
      objectId: record.objectId,
      objectName: record.objectName,
      objectKind: record.objectKind as 'environment' | 'knowledge',
      revision: record.revision,
      contentHash: record.contentHash,
      relativePath: record.relativePath,
      startLine: record.startLine,
      endLine: record.endLine,
    }))
  }

  private async resolveProposalBase(
    proposal: KnowledgeChangeProposal,
  ): Promise<{ revision: number; contentHash: string } | undefined> {
    if (proposal.targetKind === 'host-notes') {
      const notes = this.getHostNotes(proposal.targetId) ?? ''
      // Host notes use content-hash identity; revision stays at the proposal base number.
      return {
        revision: proposal.baseRevision,
        contentHash: hashText(notes),
      }
    }
    const latest = await this.knowledgeAccess.resolveLatestPublished?.(proposal.targetId)
    if (!latest) return undefined
    return { revision: latest.revision, contentHash: latest.contentHash }
  }

  private async rebaseProposalOntoCurrentBase(
    proposal: KnowledgeChangeProposal,
  ): Promise<
    | { ok: true; proposal: KnowledgeChangeProposal }
    | { ok: false; error: string; proposal: KnowledgeChangeProposal }
  > {
    if (proposal.targetKind === 'host-notes') {
      const before = this.getHostNotes(proposal.targetId) ?? ''
      const after = proposal.files.find((file) => file.relativePath === 'notes')?.after
      if (after === undefined) {
        return {
          ok: false,
          error: 'Host Notes proposal is missing notes content',
          proposal: {
            ...proposal,
            status: 'conflict',
            conflict: {
              currentRevision: proposal.baseRevision,
              currentContentHash: hashText(before),
            },
          },
        }
      }
      const rebased = rebaseKnowledgeProposal(proposal, {
        revision: proposal.baseRevision,
        contentHash: hashText(before),
        files: [{ relativePath: 'notes', before, after }],
      })
      if (!rebased.ok) {
        return {
          ok: false,
          error: rebased.error,
          proposal: {
            ...proposal,
            status: 'conflict',
            conflict: {
              currentRevision: proposal.baseRevision,
              currentContentHash: hashText(before),
            },
          },
        }
      }
      return { ok: true, proposal: rebased.proposal }
    }

    const latest = await this.knowledgeAccess.resolveLatestPublished?.(proposal.targetId)
    if (!latest || !this.knowledgeAccess.readPublishedRevisionFiles) {
      return {
        ok: false,
        error: 'Proposal target is no longer available',
        proposal: {
          ...proposal,
          status: 'conflict',
        },
      }
    }
    const baseFiles = await this.knowledgeAccess.readPublishedRevisionFiles(
      proposal.targetId,
      latest.revision,
    )
    const beforeByPath = new Map(baseFiles.map((file) => [file.relativePath, file.content]))
    const files = proposal.files.map((file) => ({
      relativePath: file.relativePath,
      before: beforeByPath.get(file.relativePath) ?? '',
      after: file.after,
    }))
    const rebased = rebaseKnowledgeProposal(proposal, {
      revision: latest.revision,
      contentHash: latest.contentHash,
      files,
    })
    if (!rebased.ok) {
      return {
        ok: false,
        error: rebased.error,
        proposal: {
          ...proposal,
          status: 'conflict',
          conflict: {
            currentRevision: latest.revision,
            currentContentHash: latest.contentHash,
          },
        },
      }
    }
    return { ok: true, proposal: rebased.proposal }
  }

  private async applyKnowledgeProposal(proposal: KnowledgeChangeProposal): Promise<string> {
    if (proposal.targetKind === 'host-notes') {
      const notesFile = proposal.files.find((file) => file.relativePath === 'notes')
      if (!notesFile) throw new Error('Host Notes proposal is missing notes content')
      // Secret scan host notes before write.
      const scan = scanKnowledgeSecrets(notesFile.after)
      if (scan.status !== 'clean') {
        const finding = scan.findings[0]
        throw new Error(
          `Host Notes contain a possible secret (${finding?.ruleId ?? 'unknown'} at line ${finding?.line ?? 1})`,
        )
      }
      const result = this.setHostNotes(proposal.targetId, notesFile.after)
      await this.refreshKnowledgeRevisionUpdates()
      return result
    }

    if (!this.knowledgeAccess.applyAcceptedKnowledgeProposal) {
      throw new Error('Knowledge proposal apply is not available')
    }
    const revision = await this.knowledgeAccess.applyAcceptedKnowledgeProposal(proposal.targetId, {
      expectedKind: proposal.targetKind,
      baseRevision: proposal.baseRevision,
      baseContentHash: proposal.baseContentHash,
      files: proposedFileContents(proposal),
    })
    await this.refreshKnowledgeRevisionUpdates()
    return `已创建修订 ${revision.revision}`
  }

  private cancelPendingKnowledgeProposals(sessionId: string): void {
    // Skip proposals currently applying so cancel cannot steal a mid-write accept.
    for (const [requestId, entry] of this.pendingKnowledgeProposals) {
      if (entry.sessionId !== sessionId) continue
      if (this.applyingKnowledgeProposals.has(requestId)) continue
      if (this.knowledgeProposalConfirms.settle(requestId, 'cancelled')) {
        this.pendingKnowledgeProposals.set(requestId, {
          ...entry,
          proposal: cancelKnowledgeProposal(entry.proposal),
        })
      }
    }
  }

  private async verifyHostKey(
    session: LiveSession,
    req: ConnectRequest,
    fingerprint: string,
    client: SSHClient,
    attemptId: number
  ): Promise<boolean> {
    const known = this.knownHosts.get(req.host, req.port)
    if (known === fingerprint) return true

    const requestId = crypto.randomUUID()
    const promise = this.hostVerifies.create(session.id, requestId)
    const request: HostVerifyRequest = {
      requestId,
      sessionId: session.id,
      host: req.host,
      port: req.port,
      fingerprint,
      knownFingerprint: known,
    }
    this.emit('hostVerify', request)

    const outcome = await promise
    if (outcome.status !== 'cancelled') this.emitHostVerifyClosed(requestId, session.id)
    if (!this.isCurrentAttempt(session, client, attemptId)) return false
    if (outcome.ok) {
      this.knownHosts.set(req.host, req.port, fingerprint)
      return true
    }
    session.pendingVerifyError = {
      attemptId,
      message: known
        ? `主机指纹已变化，连接被拒绝（known: ${known}, got: ${fingerprint}）`
        : '用户拒绝了主机指纹，连接已取消',
    }
    return false
  }

  async verifyConnectionHostKey(
    connectionId: string,
    req: Pick<ConnectRequest, 'host' | 'port'>,
    fingerprint: string
  ): Promise<boolean> {
    const known = this.knownHosts.get(req.host, req.port)
    if (known === fingerprint) return true

    const requestId = crypto.randomUUID()
    const promise = this.hostVerifies.create(connectionId, requestId)
    this.emit('hostVerify', {
      requestId,
      sessionId: connectionId,
      host: req.host,
      port: req.port,
      fingerprint,
      knownFingerprint: known,
    } satisfies HostVerifyRequest)

    const outcome = await promise
    if (outcome.status !== 'cancelled') this.emitHostVerifyClosed(requestId, connectionId)
    if (outcome.ok) this.knownHosts.set(req.host, req.port, fingerprint)
    return outcome.ok
  }

  cancelHostVerification(connectionId: string): void {
    for (const requestId of this.hostVerifies.rejectForSession(connectionId)) {
      this.emitHostVerifyClosed(requestId, connectionId)
    }
  }

  respondHostVerify(requestId: string, ok: boolean): void {
    this.hostVerifies.respond(requestId, ok)
  }

  private rejectPendingForSession(sessionId: string): void {
    this.confirms.rejectForSession(sessionId)
    this.noteConfirms.rejectForSession(sessionId)
    this.knowledgeTargetChoices.rejectForSession(sessionId)
    this.cancelPendingKnowledgeProposals(sessionId)
    for (const requestId of this.hostVerifies.rejectForSession(sessionId)) {
      this.emitHostVerifyClosed(requestId, sessionId)
    }
  }

  private emitHostVerifyClosed(requestId: string, sessionId: string): void {
    this.emit('hostVerifyClosed', { requestId, sessionId } satisfies HostVerifyClosed)
  }

  private emitAgent(event: AgentEvent): void {
    this.emit('agent', event)
  }

  /**
   * Stamp an Agent event with sessionId and the owning context epoch.
   * Callers pass an explicit epoch for late turn events so the original segment stays addressable.
   */
  private emitAgentEvent(
    session: LiveSession,
    event: Omit<AgentEvent, 'sessionId' | 'epoch'>,
    epoch: number = session.epoch.contextEpoch,
  ): void {
    this.emitAgent({ ...event, sessionId: session.id, epoch } as AgentEvent)
  }

  private readPrivateKey(keyPath: string): Buffer {
    const expanded = keyPath.startsWith('~')
      ? path.join(os.homedir(), keyPath.slice(1).replace(/^[\\/]/, ''))
      : keyPath

    if (!fs.existsSync(expanded)) {
      throw new Error(`Private key file not found: ${expanded}`)
    }

    try {
      return fs.readFileSync(expanded)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Cannot read private key: ${expanded} (${msg})`)
    }
  }

  private emitStatus(session: LiveSession): void {
    this.emit('status', this.toSummary(session))
  }

  private getSession(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown session: ' + sessionId)
    return session
  }

  private async assertAuthorizedCandidate(session: LiveSession, moduleId: string): Promise<void> {
    if (!await this.knowledgeAccess.isAuthorizedCandidate(session.environmentId, moduleId)) {
      throw new Error('Knowledge module is not authorized for this session')
    }
  }

  private toSummary(session: LiveSession): SessionSummary {
    const commandRunning = this.isCommandRunning(session)
    const blockReason = this.newContextBlockReason(session)
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      hostId: session.hostId,
      environmentId: session.environmentId,
      environmentSource: session.environmentSource,
      pinnedModuleIds: [...session.pinnedModuleIds].sort(),
      dynamicModuleIds: [...session.dynamicModuleIds].sort(),
      activeRevisions: [...session.activeRevisions.values()]
        .map((pin) => ({
          objectId: pin.objectId,
          kind: pin.kind,
          name: pin.name,
          revision: pin.revision,
          contentHash: pin.contentHash,
        }))
        .sort((left, right) => left.name.localeCompare(right.name, 'en-US')),
      revisionUpdatesAvailable: session.revisionUpdatesAvailable.slice(),
      contextEpoch: session.epoch.contextEpoch,
      epochHasActivity: session.epoch.epochHasActivity,
      commandRunning,
      ...(blockReason ? { newContextBlockReason: blockReason } : {}),
      errorMessage: session.errorMessage,
      errorKind: session.errorKind,
      policy: session.policy,
      ...(session.contextUsage ? { contextUsage: session.contextUsage } : {}),
    }
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
