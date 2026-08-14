import type {
  ApprovalResponseResult,
  KnowledgeChangeProposalPayload,
  KnowledgeTargetCandidatePayload,
} from '../shared/ipc-types'

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'conflict'
  | 'validation-failed'

export interface CommandApprovalItem {
  id: string
  kind: 'command-approval'
  requestId: string
  sessionId: string
  command: string
  risk: 'write' | 'destructive'
  status: ApprovalStatus
  /** Owning Agent context epoch when the approval was requested. */
  contextEpoch?: number
}

export interface NoteApprovalItem {
  id: string
  kind: 'note-approval'
  requestId: string
  sessionId: string
  note: string
  status: ApprovalStatus
  /** Owning Agent context epoch when the proposal was requested. */
  contextEpoch?: number
}

export interface KnowledgeProposalApprovalItem {
  id: string
  kind: 'knowledge-proposal'
  requestId: string
  sessionId: string
  proposal: KnowledgeChangeProposalPayload
  unifiedDiff: string
  status: ApprovalStatus
  message?: string
  contextEpoch?: number
}

export interface KnowledgeTargetApprovalItem {
  id: string
  kind: 'knowledge-target'
  requestId: string
  sessionId: string
  question: string
  candidates: readonly KnowledgeTargetCandidatePayload[]
  status: ApprovalStatus
  /** Index into `candidates`; set once the user picks one. */
  chosenIndex?: number
  contextEpoch?: number
}

export type ApprovalItem =
  | CommandApprovalItem
  | NoteApprovalItem
  | KnowledgeProposalApprovalItem
  | KnowledgeTargetApprovalItem
export type SessionItems<T> = Record<string, T[]>

export function appendApproval<T>(
  itemsBySession: SessionItems<T | ApprovalItem>,
  item: ApprovalItem
): SessionItems<T | ApprovalItem> {
  const duplicate = Object.values(itemsBySession)
    .some((items) => items.some((candidate) => isApprovalItem(candidate) && candidate.requestId === item.requestId))
  if (duplicate) return itemsBySession
  return {
    ...itemsBySession,
    [item.sessionId]: [...(itemsBySession[item.sessionId] ?? []), item],
  }
}

export function resolveApproval<T>(
  itemsBySession: SessionItems<T | ApprovalItem>,
  requestId: string,
  status: Exclude<ApprovalStatus, 'pending' | 'conflict' | 'validation-failed'>
): SessionItems<T | ApprovalItem> {
  return updateApproval(itemsBySession, (item) =>
    item.requestId === requestId
    && (item.status === 'pending' || item.status === 'conflict' || item.status === 'validation-failed')
      ? { ...item, status }
      : item
  )
}

export function applyApprovalResponse<T>(
  itemsBySession: SessionItems<T | ApprovalItem>,
  requestId: string,
  response: ApprovalResponseResult
): SessionItems<T | ApprovalItem> {
  return response.status
    ? resolveApproval(itemsBySession, requestId, response.status)
    : itemsBySession
}

export function closeSessionApprovals<T>(
  itemsBySession: SessionItems<T | ApprovalItem>,
  sessionId: string,
  status: Extract<ApprovalStatus, 'cancelled' | 'expired'>
): SessionItems<T | ApprovalItem> {
  const items = itemsBySession[sessionId]
  if (!items?.some((item) =>
    isApprovalItem(item)
    && (item.status === 'pending' || item.status === 'conflict' || item.status === 'validation-failed')
  )) {
    return itemsBySession
  }
  return {
    ...itemsBySession,
    [sessionId]: items.map((item) =>
      isApprovalItem(item)
      && (item.status === 'pending' || item.status === 'conflict' || item.status === 'validation-failed')
        ? { ...item, status }
        : item
    ),
  }
}

export function countPendingApprovals<T>(itemsBySession: SessionItems<T | ApprovalItem>): number {
  return Object.values(itemsBySession).reduce(
    (total, items) => total + items.filter((item) =>
      isApprovalItem(item)
      && (item.status === 'pending' || item.status === 'conflict' || item.status === 'validation-failed')
    ).length,
    0
  )
}

export function isApprovalItem(value: unknown): value is ApprovalItem {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'command-approval'
    || kind === 'note-approval'
    || kind === 'knowledge-proposal'
    || kind === 'knowledge-target'
}

export function markKnowledgeTargetChoice<T>(
  itemsBySession: SessionItems<T | ApprovalItem>,
  requestId: string,
  chosenIndex: number | null,
): SessionItems<T | ApprovalItem> {
  return updateApproval(itemsBySession, (item) => {
    if (item.kind !== 'knowledge-target' || item.requestId !== requestId) return item
    return chosenIndex === null ? item : { ...item, chosenIndex }
  })
}

export function updateKnowledgeProposalItem<T>(
  itemsBySession: SessionItems<T | ApprovalItem>,
  requestId: string,
  patch: Partial<Pick<KnowledgeProposalApprovalItem, 'proposal' | 'unifiedDiff' | 'status' | 'message'>>,
): SessionItems<T | ApprovalItem> {
  return updateApproval(itemsBySession, (item) => {
    if (item.kind !== 'knowledge-proposal' || item.requestId !== requestId) return item
    return { ...item, ...patch }
  })
}

function updateApproval<T>(
  itemsBySession: SessionItems<T | ApprovalItem>,
  update: (item: ApprovalItem) => ApprovalItem
): SessionItems<T | ApprovalItem> {
  let changed = false
  const next: SessionItems<T | ApprovalItem> = {}
  for (const [sessionId, items] of Object.entries(itemsBySession)) {
    next[sessionId] = items.map((item) => {
      if (!isApprovalItem(item)) return item
      const updated = update(item)
      if (updated !== item) changed = true
      return updated
    })
  }
  return changed ? next : itemsBySession
}
