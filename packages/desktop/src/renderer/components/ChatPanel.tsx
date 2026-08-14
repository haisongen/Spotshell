import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type {
  AgentEvent,
  ContextBoundaryPayload,
  ContextCompactionSummaryPayload,
  EnvironmentSummary,
  ExecPolicy,
  KnowledgeModuleAccessSummary,
  KnowledgeProvenanceRecord,
  SessionSummary,
  ToolEndEventMeta,
} from '../../shared/ipc-types'
import { appendTerminalPrefill, terminalInputForCommand } from '../../shared/chatDraft'
import {
  MAX_TOOL_REFERENCE_CHARS,
  addPendingReference,
  createMessageReference,
  isReferenceableFromEpoch,
  removePendingReference,
  toAgentChatQuote,
  type MessageReferenceSnapshot,
} from '../../shared/messageReference'
import { useTranslation } from '../i18n'
import { setSessionActive } from '../chatSessionActivity'
import { setSessionValue } from '../chatSessionState'
import { formatContextBoundaryLabel } from '../contextBoundary'
import {
  applyApprovalResponse,
  appendApproval,
  closeSessionApprovals,
  countPendingApprovals,
  isApprovalItem,
  markKnowledgeTargetChoice,
  resolveApproval,
  updateKnowledgeProposalItem,
  type ApprovalItem,
} from '../chatApprovals'
import type { ApprovalRespondOptions } from './ChatApprovalCard'
import {
  findPendingToolIndex,
  findStreamingAssistantIndex,
  insertForEpoch,
  sealStreamingAssistant,
} from '../chatEpochEvents'
import { AssistantMessage } from './AssistantMessage'
import { ChatApprovalCard } from './ChatApprovalCard'
import { ChatHeaderOverflowMenu } from './ChatHeaderOverflowMenu'
import { ChatContextBar } from './ChatContextBar'
import { ToolCard } from './ToolCard'

const COMPACT_HEADER_WIDTH = 480

type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  pendingTool?: boolean
  toolCommand?: string
  toolMeta?: ToolEndEventMeta
  streaming?: boolean
  provenance?: KnowledgeProvenanceRecord[]
  /** Backend Agent context segment that produced this item. */
  contextEpoch?: number
  /** ISO timestamp when the visible item was created. */
  createdAt?: string
  /** Visible divider between Agent context segments; transcript stays intact. */
  kind?: 'context_boundary' | 'context_quote' | 'context_compaction' | 'knowledge_revision_switch'
  boundary?: ContextBoundaryPayload
  /** Frozen quote card content when kind is context_quote. */
  quote?: MessageReferenceSnapshot
  /** Inspectable one-shot compaction summary when kind is context_compaction. */
  compaction?: ContextCompactionSummaryPayload
  /** Expand/collapse state for compaction summary body. */
  compactionExpanded?: boolean
}

type ChatItem = ChatMessage | ApprovalItem

interface ChatPanelProps {
  hidden: boolean
  width: number
  sessionId: string | null
  hasApiKey: boolean
  policy: ExecPolicy
  onChangePolicy: (policy: ExecPolicy) => void
  onCollapse: () => void
  onOpenSettings: () => void
  prefill: { text: string; nonce: number } | null
  onHostNotesSaved: () => void
  sessionReady: boolean
  session: SessionSummary | null
  environments: EnvironmentSummary[]
  modules: KnowledgeModuleAccessSummary[]
  onEnvironmentSelect: (environmentId: string | undefined, persistForHost: boolean) => Promise<void>
  onKnowledgeAction: (action: 'load' | 'pin' | 'unpin' | 'unload', moduleId: string) => Promise<void>
  onApplyRevision: (
    objectId: string,
    targetRevision: number,
    targetContentHash: string,
  ) => Promise<void>
  onKeepRevision: (
    objectId: string,
    latestRevision: number,
    latestContentHash: string,
  ) => Promise<void>
  onManageKnowledge: (moduleId?: string) => void
  onManageEnvironment: (environmentId: string) => void
  onPendingCountChange: (count: number) => void
}

function nextId(): string {
  return crypto.randomUUID()
}

function formatToolInput(input: unknown): string {
  if (input && typeof input === 'object' && 'command' in input) {
    const command = (input as { command?: unknown }).command
    if (typeof command === 'string') return command
  }
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

export function ChatPanel({
  hidden,
  width,
  sessionId,
  hasApiKey,
  policy,
  onChangePolicy,
  onCollapse,
  onOpenSettings,
  prefill,
  onHostNotesSaved,
  sessionReady,
  session,
  environments,
  modules,
  onEnvironmentSelect,
  onKnowledgeAction,
  onApplyRevision,
  onKeepRevision,
  onManageKnowledge,
  onManageEnvironment,
  onPendingCountChange,
}: ChatPanelProps): JSX.Element {
  const { language, t } = useTranslation()
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatItem[]>>({})
  const [pendingQuotesBySession, setPendingQuotesBySession] = useState<
    Record<string, MessageReferenceSnapshot[]>
  >({})
  const [draft, setDraft] = useState('')
  const [busySessions, setBusySessions] = useState<ReadonlySet<string>>(() => new Set())
  const [respondingRequests, setRespondingRequests] = useState<ReadonlySet<string>>(() => new Set())
  const [statusBySession, setStatusBySession] = useState<Record<string, string>>({})
  const [errorBySession, setErrorBySession] = useState<Record<string, string>>({})
  const listRef = useRef<HTMLDivElement>(null)
  const busySessionsRef = useRef(new Set<string>())
  const respondingRequestsRef = useRef(new Set<string>())
  const lastPrefillNonce = useRef(0)

  const messages = useMemo(() => {
    if (!sessionId) return []
    return messagesBySession[sessionId] ?? []
  }, [messagesBySession, sessionId])
  const pendingQuotes = useMemo(() => {
    if (!sessionId) return []
    return pendingQuotesBySession[sessionId] ?? []
  }, [pendingQuotesBySession, sessionId])
  /** sourceMessageId → pending quote id, used to flip source buttons to “已引用”. */
  const pendingQuoteIdBySource = useMemo(() => {
    const map = new Map<string, string>()
    for (const quote of pendingQuotes) {
      map.set(quote.sourceMessageId, quote.id)
    }
    return map
  }, [pendingQuotes])
  const currentEpoch = session?.contextEpoch ?? 1
  const busy = sessionId ? busySessions.has(sessionId) : false
  const statusText = sessionId ? statusBySession[sessionId] ?? null : null
  const error = sessionId ? errorBySession[sessionId] ?? null : null

  const updateSessionStatus = useCallback((sid: string, value: string | null) => {
    setStatusBySession((current) => setSessionValue(current, sid, value))
  }, [])

  const updateSessionError = useCallback((sid: string, value: string | null) => {
    setErrorBySession((current) => setSessionValue(current, sid, value))
  }, [])

  const updateSessionBusy = useCallback((sid: string, value: boolean) => {
    busySessionsRef.current = setSessionActive(busySessionsRef.current, sid, value)
    setBusySessions(busySessionsRef.current)
  }, [])

  const updateRequestResponding = useCallback((requestId: string, value: boolean) => {
    if (value) respondingRequestsRef.current.add(requestId)
    else respondingRequestsRef.current.delete(requestId)
    setRespondingRequests(new Set(respondingRequestsRef.current))
  }, [])

  const appendMessage = useCallback((sid: string, message: ChatItem) => {
    setMessagesBySession((prev) => {
      const existing = prev[sid] ?? []
      return { ...prev, [sid]: [...existing, message] }
    })
  }, [])

  const pendingCount = useMemo(() => countPendingApprovals(messagesBySession), [messagesBySession])

  useEffect(() => {
    onPendingCountChange(pendingCount)
  }, [onPendingCountChange, pendingCount])

  useEffect(() => {
    const unsub = window.spotshell.onAgentEvent((event: AgentEvent) => {
      if (!event.sessionId) return

      if (event.type === 'status') {
        updateSessionStatus(event.sessionId, event.text)
        return
      }

      if (event.type === 'approval_resolved') {
        setMessagesBySession((prev) => resolveApproval(prev, event.requestId, event.status))
        updateRequestResponding(event.requestId, false)
        if (event.status !== 'approved') updateSessionStatus(event.sessionId, null)
        return
      }

      if (event.type === 'token_delta') {
        setMessagesBySession((prev) => {
          const existing = prev[event.sessionId] ?? []
          const streamAt = findStreamingAssistantIndex(existing, event.epoch)
          if (streamAt >= 0) {
            const last = existing[streamAt]!
            if (!isApprovalItem(last) && last.role === 'assistant') {
              const copy = existing.slice()
              copy[streamAt] = {
                ...last,
                content: last.content + event.text,
                contextEpoch: event.epoch,
              }
              return { ...prev, [event.sessionId]: copy }
            }
          }
          return {
            ...prev,
            [event.sessionId]: insertForEpoch(existing, {
              id: nextId(),
              role: 'assistant',
              content: event.text,
              streaming: true,
              contextEpoch: event.epoch,
            }),
          }
        })
        return
      }

      if (event.type === 'tool_start') {
        const command = formatToolInput(event.input)
        setMessagesBySession((prev) => ({
          ...prev,
          // Seal the current text bubble first: text produced after this tool
          // belongs below the card, not appended to what was said before it.
          [event.sessionId]: insertForEpoch(
            sealStreamingAssistant(prev[event.sessionId] ?? [], event.epoch),
            {
              id: nextId(),
              role: 'tool',
              content: '',
              pendingTool: true,
              toolCommand: command,
              contextEpoch: event.epoch,
            },
          ),
        }))
        updateSessionStatus(event.sessionId, t('runningTool'))
        return
      }

      if (event.type === 'tool_end') {
        const content = event.output?.trim()
          ? event.output.slice(0, 4000)
          : t('noOutput')
        setMessagesBySession((prev) => {
          const existing = prev[event.sessionId] ?? []
          const toolAt = findPendingToolIndex(existing, event.epoch)
          if (toolAt >= 0) {
            const current = existing[toolAt]!
            if (!isApprovalItem(current) && current.role === 'tool') {
              const copy = existing.slice()
              copy[toolAt] = {
                ...current,
                content,
                pendingTool: false,
                toolMeta: event.meta,
                contextEpoch: event.epoch,
              }
              return { ...prev, [event.sessionId]: copy }
            }
          }
          return {
            ...prev,
            [event.sessionId]: insertForEpoch(existing, {
              id: nextId(),
              role: 'tool',
              content,
              toolCommand: event.name,
              toolMeta: event.meta,
              contextEpoch: event.epoch,
            }),
          }
        })
        updateSessionStatus(event.sessionId, null)
        return
      }

      if (event.type === 'final') {
        const provenance = event.provenance && event.provenance.length > 0
          ? event.provenance
          : undefined
        setMessagesBySession((prev) => {
          const closed = closeSessionApprovals(prev, event.sessionId, 'expired')
          const existing = closed[event.sessionId] ?? []
          const streamAt = findStreamingAssistantIndex(existing, event.epoch)
          if (streamAt >= 0) {
            const current = existing[streamAt]!
            if (!isApprovalItem(current) && current.role === 'assistant') {
              const copy = existing.slice()
              copy[streamAt] = {
                ...current,
                // The streamed text already holds this round's content; `final`
                // only seals it. Overwriting would drop it when the payload is a
                // stringified non-text content block. Fall back only when the
                // model never streamed a token.
                content: current.content || event.text,
                streaming: false,
                contextEpoch: event.epoch,
                ...(provenance ? { provenance } : {}),
              }
              return { ...closed, [event.sessionId]: copy }
            }
          }
          // Nothing streamed for the closing round: open a bubble below the last
          // tool card. An empty payload with no provenance has nothing to show.
          if (!event.text && !provenance) return closed
          return {
            ...closed,
            [event.sessionId]: insertForEpoch(existing, {
              id: nextId(),
              role: 'assistant',
              content: event.text,
              contextEpoch: event.epoch,
              ...(provenance ? { provenance } : {}),
            }),
          }
        })
        updateSessionBusy(event.sessionId, false)
        updateSessionStatus(event.sessionId, null)
        return
      }

      if (event.type === 'knowledge_module_selected') {
        const { selection } = event
        setMessagesBySession((prev) => ({
          ...prev,
          [event.sessionId]: insertForEpoch(prev[event.sessionId] ?? [], {
            id: nextId(),
            role: 'system',
            contextEpoch: event.epoch,
            content: t('knowledgeModuleSelected', {
              name: selection.moduleName,
              revision: String(selection.revision),
              loadType: selection.loadType,
              reason: selection.reason,
            }),
          }),
        }))
        return
      }

      if (event.type === 'knowledge_revision_switch') {
        setMessagesBySession((prev) => ({
          ...prev,
          [event.sessionId]: insertForEpoch(prev[event.sessionId] ?? [], {
            id: nextId(),
            role: 'system',
            kind: 'knowledge_revision_switch',
            contextEpoch: event.epoch,
            content: t('knowledgeRevisionSwitch', {
              name: event.name,
              from: String(event.fromRevision),
              to: String(event.toRevision),
            }),
          }),
        }))
        return
      }

      if (event.type === 'context_boundary') {
        const { sessionId: boundarySessionId, type: _type, ...boundary } = event
        appendMessage(boundarySessionId, {
          id: nextId(),
          role: 'system',
          kind: 'context_boundary',
          contextEpoch: boundary.epoch,
          boundary,
          content: formatContextBoundaryLabel(boundary, language),
        })
        return
      }

      if (event.type === 'context_compaction') {
        appendMessage(event.sessionId, {
          id: nextId(),
          role: 'system',
          kind: 'context_compaction',
          contextEpoch: event.epoch,
          compaction: event.summary,
          compactionExpanded: false,
          content: t('contextCompacted'),
          createdAt: event.summary.createdAt,
        })
        return
      }

      if (event.type === 'context_compaction_failed') {
        appendMessage(event.sessionId, {
          id: nextId(),
          role: 'system',
          contextEpoch: event.epoch,
          content: t('contextCompactionFailed', { error: event.error }),
        })
        return
      }

      if (event.type === 'context_over_limit') {
        const content = event.reason === 'auto_compact_disabled'
          ? t('contextOverLimitDisabled')
          : event.reason === 'summary_budget_exhausted'
            ? t('contextOverLimitSummaryBudget')
            : t('contextOverLimitNothingEligible')
        appendMessage(event.sessionId, {
          id: nextId(),
          role: 'system',
          contextEpoch: event.epoch,
          content,
        })
        return
      }

      if (event.type === 'cancelled') {
        setMessagesBySession((prev) => {
          const closed = closeSessionApprovals(prev, event.sessionId, 'cancelled')
          const existing = closed[event.sessionId] ?? []
          const copy = existing.slice()
          const streamAt = findStreamingAssistantIndex(copy, event.epoch)
          if (streamAt >= 0) {
            const current = copy[streamAt]!
            if (!isApprovalItem(current) && current.role === 'assistant') {
              copy[streamAt] = { ...current, streaming: false, contextEpoch: event.epoch }
            }
          }
          return {
            ...closed,
            [event.sessionId]: insertForEpoch(copy, {
              id: nextId(),
              role: 'system',
              contextEpoch: event.epoch,
              content: t('cancelledByUser'),
            }),
          }
        })
        updateSessionBusy(event.sessionId, false)
        updateSessionStatus(event.sessionId, null)
        return
      }

      if (event.type === 'error') {
        setMessagesBySession((prev) => {
          const closed = closeSessionApprovals(prev, event.sessionId, 'expired')
          return {
            ...closed,
            [event.sessionId]: [
              ...(closed[event.sessionId] ?? []),
              { id: nextId(), role: 'system', content: event.text },
            ],
          }
        })
        updateSessionBusy(event.sessionId, false)
        updateSessionError(event.sessionId, event.text)
        updateSessionStatus(event.sessionId, null)
        return
      }

      if (event.type === 'note_proposal') {
        setMessagesBySession((prev) => appendApproval(prev, {
          id: nextId(), kind: 'note-approval', requestId: event.requestId,
          note: event.note, sessionId: event.sessionId, status: 'pending',
          contextEpoch: event.epoch,
        }))
        return
      }

      if (event.type === 'knowledge_target_question') {
        setMessagesBySession((prev) => appendApproval(prev, {
          id: nextId(), kind: 'knowledge-target', requestId: event.requestId,
          sessionId: event.sessionId, question: event.question,
          candidates: event.candidates, status: 'pending',
          contextEpoch: event.epoch,
        }))
        updateSessionStatus(event.sessionId, t('awaitingConfirmation'))
        return
      }

      if (event.type === 'knowledge_proposal') {
        setMessagesBySession((prev) => {
          const existing = (prev[event.sessionId] ?? []).some(
            (message) => isApprovalItem(message) && message.requestId === event.requestId,
          )
          if (existing) {
            return updateKnowledgeProposalItem(prev, event.requestId, {
              proposal: event.proposal,
              unifiedDiff: event.unifiedDiff,
              status: event.proposal.status === 'conflict'
                ? 'conflict'
                : event.proposal.status === 'validation-failed'
                  ? 'validation-failed'
                  : 'pending',
            })
          }
          return appendApproval(prev, {
            id: nextId(),
            kind: 'knowledge-proposal',
            requestId: event.requestId,
            sessionId: event.sessionId,
            proposal: event.proposal,
            unifiedDiff: event.unifiedDiff,
            status: event.proposal.status === 'conflict'
              ? 'conflict'
              : event.proposal.status === 'validation-failed'
                ? 'validation-failed'
                : 'pending',
            contextEpoch: event.epoch,
          })
        })
        return
      }

      if (event.type === 'confirm_required') {
        setMessagesBySession((prev) => appendApproval(prev, {
          id: nextId(), kind: 'command-approval', requestId: event.requestId,
          command: event.command, sessionId: event.sessionId, risk: event.risk, status: 'pending',
          contextEpoch: event.epoch,
        }))
        updateSessionStatus(event.sessionId, t('awaitingConfirmation'))
      }
    })

    return unsub
  }, [appendMessage, language, t, updateRequestResponding, updateSessionBusy, updateSessionError, updateSessionStatus])

  useEffect(() => {
    if (hidden) return
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [hidden, messages, statusText])

  useEffect(() => {
    if (!prefill || prefill.nonce === lastPrefillNonce.current) return
    lastPrefillNonce.current = prefill.nonce
    setDraft((current) => appendTerminalPrefill(current, prefill.text))
  }, [prefill])

  function quoteMessage(message: ChatMessage, options?: { headFragment?: boolean }): void {
    if (!sessionId) return
    const maxChars = message.role === 'tool' ? MAX_TOOL_REFERENCE_CHARS : undefined
    const needsFragment = message.role === 'tool'
      && message.content.length > MAX_TOOL_REFERENCE_CHARS
    const charRange = options?.headFragment || needsFragment
      ? { start: 0, end: MAX_TOOL_REFERENCE_CHARS }
      : undefined
    // Oversized tool output never auto-joins; user must pick an explicit fragment action.
    if (needsFragment && !options?.headFragment) {
      updateSessionError(sessionId, t('quoteTooLarge', {
        max: String(maxChars ?? MAX_TOOL_REFERENCE_CHARS),
      }))
      return
    }

    const role = message.role
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      updateSessionError(sessionId, t('quoteNotAvailable'))
      return
    }

    const created = createMessageReference({
      id: message.id,
      role,
      content: message.content,
      contextEpoch: message.contextEpoch,
      createdAt: message.createdAt,
    }, {
      currentEpoch,
      charRange: options?.headFragment ? { start: 0, end: MAX_TOOL_REFERENCE_CHARS } : charRange,
    })
    if (!created.ok) {
      if (created.error === 'tool_output_too_large' || created.error === 'message_too_large') {
        updateSessionError(sessionId, t('quoteTooLarge', {
          max: String(created.maxChars ?? MAX_TOOL_REFERENCE_CHARS),
        }))
        return
      }
      if (created.error === 'same_or_newer_epoch' || created.error === 'not_referenceable_role') {
        updateSessionError(sessionId, t('quoteNotAvailable'))
        return
      }
      updateSessionError(sessionId, t('quoteNotAvailable'))
      return
    }

    const existing = pendingQuotesBySession[sessionId] ?? []
    const next = addPendingReference(existing, created.reference)
    if (!next.ok) {
      updateSessionError(sessionId, t('quoteLimitReached'))
      return
    }
    updateSessionError(sessionId, null)
    setPendingQuotesBySession((prev) => ({ ...prev, [sessionId]: next.pending }))
  }

  function removeQuote(referenceId: string): void {
    if (!sessionId) return
    setPendingQuotesBySession((prev) => ({
      ...prev,
      [sessionId]: removePendingReference(prev[sessionId] ?? [], referenceId),
    }))
  }

  /** Source-message action: quote, or unquote when already pending. */
  function renderQuoteAction(message: ChatMessage): JSX.Element | null {
    if (!isReferenceableFromEpoch(message.contextEpoch, currentEpoch)) return null
    if (message.role === 'tool' && message.pendingTool) return null
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') {
      return null
    }

    const pendingId = pendingQuoteIdBySource.get(message.id)
    if (pendingId) {
      return (
        <div className="chat-message-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost chat-quote-action chat-quote-action-active"
            onClick={() => removeQuote(pendingId)}
            title={t('removeQuote')}
            aria-label={t('removeQuote')}
          >
            {t('quoteAlreadyReferenced')}
          </button>
        </div>
      )
    }

    const oversizedTool = message.role === 'tool'
      && message.content.length > MAX_TOOL_REFERENCE_CHARS
    return (
      <div className="chat-message-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost chat-quote-action"
          onClick={() => quoteMessage(message, oversizedTool ? { headFragment: true } : undefined)}
        >
          {oversizedTool
            ? t('quoteHeadFragment', { max: String(MAX_TOOL_REFERENCE_CHARS) })
            : t('quoteToCurrentContext')}
        </button>
      </div>
    )
  }

  async function sendMessage(rawText: string): Promise<void> {
    if (!sessionId || busySessionsRef.current.has(sessionId)) return

    const text = rawText.trim()
    if (!text) return
    if (!hasApiKey) {
      updateSessionError(sessionId, t('apiKeyChatRequired'))
      return
    }

    const quotesToSend = pendingQuotesBySession[sessionId] ?? []
    updateSessionError(sessionId, null)
    const targetSessionId = sessionId
    const turnEpoch = currentEpoch
    const now = new Date().toISOString()
    updateSessionBusy(targetSessionId, true)
    updateSessionStatus(targetSessionId, t('thinking'))

    // Visible quote cards enter the current epoch; snapshots are already frozen.
    for (const quote of quotesToSend) {
      appendMessage(targetSessionId, {
        id: nextId(),
        role: 'system',
        kind: 'context_quote',
        contextEpoch: turnEpoch,
        createdAt: now,
        content: quote.contentSnapshot,
        quote,
      })
    }
    appendMessage(sessionId, {
      id: nextId(),
      role: 'user',
      content: text,
      contextEpoch: turnEpoch,
      createdAt: now,
    })
    setPendingQuotesBySession((prev) => ({ ...prev, [targetSessionId]: [] }))

    try {
      await window.spotshell.agentChat({
        sessionId: targetSessionId,
        message: text,
        quotes: quotesToSend.map(toAgentChatQuote),
      })
      // Final assistant message is appended via onAgentEvent('final').
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const blockedSecret = /secret scan/i.test(msg)
      // Restore removable pending quotes so the user can drop a blocked fragment.
      if (quotesToSend.length > 0) {
        setPendingQuotesBySession((prev) => ({
          ...prev,
          [targetSessionId]: quotesToSend,
        }))
      }
      appendMessage(targetSessionId, {
        id: nextId(),
        role: 'system',
        content: blockedSecret ? t('quoteBlockedSecret') : msg,
        contextEpoch: turnEpoch,
        createdAt: new Date().toISOString(),
      })
      updateSessionBusy(targetSessionId, false)
      updateSessionError(targetSessionId, blockedSecret ? t('quoteBlockedSecret') : msg)
      updateSessionStatus(targetSessionId, null)
    }
  }

  async function handleSend(e?: FormEvent): Promise<void> {
    e?.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await sendMessage(text)
  }

  async function handleClear(): Promise<void> {
    if (!sessionId) return
    try {
      await window.spotshell.agentClear(sessionId)
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? []).filter(isApprovalItem),
      }))
      updateSessionError(sessionId, null)
      updateSessionStatus(sessionId, null)
    } catch (err: unknown) {
      updateSessionError(sessionId, err instanceof Error ? err.message : String(err))
    }
  }

  async function handleStartNewContext(): Promise<void> {
    if (!sessionId) return
    try {
      // Backend emits a context_boundary event; keep the full visible transcript.
      await window.spotshell.startNewContext(sessionId)
      updateSessionError(sessionId, null)
      updateSessionStatus(sessionId, null)
    } catch (err: unknown) {
      updateSessionError(sessionId, err instanceof Error ? err.message : String(err))
    }
  }

  async function handleApprovalRespond(
    item: ApprovalItem,
    approved: boolean,
    options?: ApprovalRespondOptions,
  ): Promise<void> {
    const actionable = item.status === 'pending'
      || item.status === 'conflict'
      || item.status === 'validation-failed'
    if (!actionable || respondingRequestsRef.current.has(item.requestId)) return
    updateRequestResponding(item.requestId, true)
    try {
      if (item.kind === 'knowledge-target') {
        // `approved` only distinguishes "picked one" from "none of these"; the
        // index is what the agent is actually waiting for.
        const optionIndex = approved ? options?.optionIndex ?? 0 : null
        const result = await window.spotshell.respondKnowledgeTarget(item.requestId, optionIndex)
        if (result.accepted && optionIndex !== null) {
          setMessagesBySession((prev) => markKnowledgeTargetChoice(prev, item.requestId, optionIndex))
        }
        setMessagesBySession((prev) => applyApprovalResponse(prev, item.requestId, result))
        // The agent resumes either way: it writes the chosen target, or explains why it stopped.
        updateSessionStatus(item.sessionId, result.accepted ? t('thinking') : null)
        return
      }

      if (item.kind === 'knowledge-proposal') {
        const result = await window.spotshell.respondKnowledgeProposal({
          requestId: item.requestId,
          ok: approved,
          reason: options?.reason,
          terminalEvidence: options?.terminalEvidence,
          files: options?.files,
          promoteToGuidance: options?.promoteToGuidance,
        })
        if (result.proposal) {
          setMessagesBySession((prev) => updateKnowledgeProposalItem(prev, item.requestId, {
            proposal: result.proposal!,
            unifiedDiff: result.unifiedDiff ?? item.unifiedDiff,
            status: result.status === 'approved'
              ? 'approved'
              : result.status === 'rejected'
                ? 'rejected'
                : result.status === 'cancelled'
                  ? 'cancelled'
                  : result.status === 'expired'
                    ? 'expired'
                    : result.status === 'conflict'
                      ? 'conflict'
                      : result.status === 'validation-failed'
                        ? 'validation-failed'
                        : item.status,
            message: result.message,
          }))
        } else if (result.status) {
          setMessagesBySession((prev) => resolveApproval(prev, item.requestId, result.status as 'approved' | 'rejected' | 'cancelled' | 'expired'))
        }
        if (result.accepted && result.status === 'approved') {
          if (item.proposal.targetKind === 'host-notes') onHostNotesSaved()
          updateSessionStatus(item.sessionId, null)
        } else if (result.status === 'conflict' || result.status === 'validation-failed') {
          updateSessionError(item.sessionId, result.message ?? t('knowledgeProposalValidationFailed'))
        } else if (result.status && result.status !== 'approved') {
          updateSessionStatus(item.sessionId, null)
        }
        return
      }

      const result = item.kind === 'command-approval'
        ? await window.spotshell.respondDangerConfirm(item.requestId, approved)
        : await window.spotshell.respondNoteProposal(item.requestId, approved)
      setMessagesBySession((prev) => applyApprovalResponse(prev, item.requestId, result))
      if (result.status === 'approved' && item.kind === 'command-approval') {
        updateSessionStatus(item.sessionId, t('runningTool'))
      }
      if (result.status && result.status !== 'approved') updateSessionStatus(item.sessionId, null)
      if (result.accepted && result.status === 'approved' && item.kind === 'note-approval') onHostNotesSaved()
    } catch (responseError: unknown) {
      updateSessionError(
        item.sessionId,
        responseError instanceof Error ? responseError.message : String(responseError)
      )
    } finally {
      updateRequestResponding(item.requestId, false)
    }
  }

  function insertToTerminal(command: string, run: boolean): void {
    if (!sessionId) return
    window.spotshell.termInput(sessionId, terminalInputForCommand(command, run))
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const canSend = Boolean(sessionId) && hasApiKey && !busy && draft.trim().length > 0
  const compactHeader = width < COMPACT_HEADER_WIDTH

  return (
    <aside
      className={`chat-panel${hidden ? ' chat-panel-hidden' : ''}`}
      style={{ width, flexBasis: width }}
      aria-hidden={hidden}
    >
      <div className={`chat-panel-header${compactHeader ? ' chat-panel-header-compact' : ''}`}>
        <div className="rail-heading">
          <h2>{t('aiChat')}</h2>
        </div>
        <div className="chat-panel-actions">
          {compactHeader ? (
            <ChatHeaderOverflowMenu
              policy={policy}
              policyDisabled={!sessionId}
              hidden={hidden}
              onChangePolicy={onChangePolicy}
            />
          ) : (
            <div className="chat-panel-direct-controls">
              <select
                className="chat-policy-select"
                value={policy}
                disabled={!sessionId}
                title={t('policyLabel')}
                aria-label={t('policyLabel')}
                onChange={(event) => onChangePolicy(event.target.value as ExecPolicy)}
              >
                <option value="readonly">{t('policyReadonly')}</option>
                <option value="ask">{t('policyAsk')}</option>
                <option value="auto">{t('policyAuto')}</option>
              </select>
            </div>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost chat-clear-button"
            disabled={!sessionId || busy}
            onClick={() => {
              void handleClear()
            }}
          >
            {t('clear')}
          </button>
          <button
            type="button"
            className="chat-panel-toggle"
            title={t('collapseChat')}
            aria-label={t('collapseChat')}
            aria-expanded="true"
            onClick={onCollapse}
          >
            <span aria-hidden>&gt;</span>
          </button>
        </div>
      </div>

      {session ? (
        <ChatContextBar
          key={session.id}
          session={session}
          environments={environments}
          modules={modules}
          onEnvironmentSelect={onEnvironmentSelect}
          onModuleAction={onKnowledgeAction}
          onApplyRevision={onApplyRevision}
          onKeepRevision={onKeepRevision}
          onManage={onManageKnowledge}
          onManageEnvironment={onManageEnvironment}
          onStartNewContext={handleStartNewContext}
          newContextDisabled={Boolean(session.commandRunning)}
          newContextBlockReason={
            session.commandRunning ? t('startNewContextBlockedCommand') : undefined
          }
        />
      ) : null}

      {!hasApiKey ? (
        <div className="chat-empty">
          <p className="hint">{t('addApiKeyHint')}</p>
          <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
            {t('openSettings')}
          </button>
        </div>
      ) : !sessionId ? (
        <div className="chat-empty">
          <p className="hint">{t('connectChatHint')}</p>
        </div>
      ) : (
        <>
          <div className="chat-messages" ref={listRef}>
            {messages.length === 0 ? (
              <p className="muted chat-placeholder">
                {t('chatPlaceholder')}
              </p>
            ) : (
              messages.map((m) => isApprovalItem(m) ? (
                <ChatApprovalCard
                  key={m.id}
                  item={m}
                  responding={respondingRequests.has(m.requestId)}
                  onRespond={(item, approved, options) => { void handleApprovalRespond(item, approved, options) }}
                />
              ) : !isApprovalItem(m) && m.kind === 'context_boundary' ? (
                <div
                  key={m.id}
                  className="chat-context-boundary"
                  role="separator"
                  aria-label={m.content}
                >
                  <span className="chat-context-boundary-line" aria-hidden="true" />
                  <span className="chat-context-boundary-label">{m.content}</span>
                  <span className="chat-context-boundary-line" aria-hidden="true" />
                </div>
              ) : !isApprovalItem(m) && m.kind === 'context_compaction' && m.compaction ? (
                <div
                  key={m.id}
                  className="chat-compaction-card"
                  data-compaction-id={m.compaction.id}
                >
                  <div className="chat-compaction-card-header">
                    <span className="chat-compaction-card-title">{t('contextCompacted')}</span>
                    <span className="chat-compaction-card-meta">
                      {t('contextCompactedDetail', {
                        count: String(m.compaction.coveredMessageIds.length),
                        model: m.compaction.model,
                      })}
                    </span>
                  </div>
                  <p className="chat-compaction-card-range muted">
                    {m.compaction.coveredFromPreview}
                    {' … '}
                    {m.compaction.coveredToPreview}
                  </p>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      if (!sessionId) return
                      setMessagesBySession((prev) => {
                        const list = prev[sessionId] ?? []
                        return {
                          ...prev,
                          [sessionId]: list.map((item) => (
                            !isApprovalItem(item) && item.id === m.id
                              ? { ...item, compactionExpanded: !item.compactionExpanded }
                              : item
                          )),
                        }
                      })
                    }}
                  >
                    {m.compactionExpanded ? t('hideCompactionSummary') : t('viewCompactionSummary')}
                  </button>
                  {m.compactionExpanded ? (
                    <pre className="chat-compaction-card-body">{m.compaction.text}</pre>
                  ) : null}
                </div>
              ) : !isApprovalItem(m) && m.kind === 'context_quote' && m.quote ? (
                <div key={m.id} className="chat-quote-card chat-quote-card-sent" data-quote-id={m.quote.id}>
                  <div className="chat-quote-card-header">
                    <span className="chat-quote-card-label">
                      {t('quotedFromOldContext', { epoch: String(m.quote.sourceEpoch) })}
                    </span>
                    <span className="chat-quote-card-meta">{m.quote.role}</span>
                  </div>
                  <pre className="chat-quote-card-body">{m.quote.contentSnapshot}</pre>
                </div>
              ) : m.role === 'tool' ? (
                <div key={m.id} className="chat-message-with-actions">
                  <ToolCard
                    command={m.toolCommand ?? ''}
                    output={m.content}
                    meta={m.toolMeta}
                    pending={Boolean(m.pendingTool)}
                  />
                  {renderQuoteAction(m)}
                </div>
              ) : m.role === 'assistant' ? (
                <div key={m.id} className="chat-bubble chat-bubble-assistant chat-message-with-actions">
                  <div className="chat-bubble-role">{t('assistant')}</div>
                  <AssistantMessage
                    content={m.content}
                    provenance={m.provenance}
                    onInsert={sessionReady && sessionId
                      ? (command) => insertToTerminal(command, false)
                      : undefined}
                    onRun={sessionReady && sessionId
                      ? (command) => insertToTerminal(command, true)
                      : undefined}
                    onOpenKnowledge={(objectId) => onManageKnowledge(objectId)}
                  />
                  {renderQuoteAction(m)}
                </div>
              ) : (
                <div key={m.id} className={`chat-bubble chat-bubble-${m.role} chat-message-with-actions`}>
                  <div className="chat-bubble-role">
                    {m.role === 'user'
                      ? t('you')
                      : t('system')}
                  </div>
                  <pre className="chat-bubble-body">{m.content}</pre>
                  {m.role === 'user' ? renderQuoteAction(m) : null}
                </div>
              ))
            )}
            {statusText ? <p className="chat-status">{statusText}...</p> : null}
            {error ? <p className="form-error">{error}</p> : null}
          </div>

          {pendingQuotes.length > 0 ? (
            <div className="chat-pending-quotes" aria-label={t('quotedFromOldContext', { epoch: '' }).trim()}>
              {pendingQuotes.map((quote) => (
                <div key={quote.id} className="chat-quote-card">
                  <div className="chat-quote-card-header">
                    <span className="chat-quote-card-label">
                      {t('quotedFromOldContext', { epoch: String(quote.sourceEpoch) })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => removeQuote(quote.id)}
                      aria-label={t('removeQuote')}
                    >
                      {t('removeQuote')}
                    </button>
                  </div>
                  <pre className="chat-quote-card-body">{quote.contentSnapshot}</pre>
                </div>
              ))}
            </div>
          ) : null}

          <form className="chat-composer" onSubmit={(e) => void handleSend(e)}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={t('messageAgent')}
              rows={3}
              disabled={busy}
            />
            <div className="chat-composer-actions">
              <span className="muted chat-hint">{t('composerHint')}</span>
              <div className="chat-submit-actions">
                {busy ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      if (sessionId) window.spotshell.agentCancel(sessionId)
                    }}
                  >
                    {t('stop')}
                  </button>
                ) : null}
                <button type="submit" className="btn btn-primary btn-sm" disabled={!canSend}>
                  {busy ? t('sending') : t('send')}
                </button>
              </div>
            </div>
          </form>
        </>
      )}

    </aside>
  )
}
