/**
 * Explicit old-context message quotes for the current Agent epoch.
 * Visible transcript browsing never auto-includes content; only this path does.
 */

export const MAX_TOOL_REFERENCE_CHARS = 2_000
export const MAX_MESSAGE_REFERENCE_CHARS = 8_000
export const MAX_PENDING_REFERENCES = 5
export const MAX_PENDING_REFERENCE_TOTAL_CHARS = 12_000

export type ReferenceableRole = 'user' | 'assistant' | 'tool'

export interface ReferenceableMessage {
  id: string
  role: ReferenceableRole | 'system'
  content: string
  contextEpoch?: number
  createdAt?: string
}

export interface MessageReferenceSnapshot {
  id: string
  sourceMessageId: string
  sourceEpoch: number
  role: ReferenceableRole
  /** Original source message timestamp when known. */
  createdAt: string
  /** When the user created this pending/sent quote. */
  referencedAt: string
  contentSnapshot: string
  truncated: boolean
  charRange?: { start: number; end: number }
}

export type CreateReferenceError =
  | 'not_referenceable_role'
  | 'same_or_newer_epoch'
  | 'empty_content'
  | 'tool_output_too_large'
  | 'message_too_large'
  | 'invalid_range'

export type CreateReferenceResult =
  | { ok: true; reference: MessageReferenceSnapshot }
  | { ok: false; error: CreateReferenceError; maxChars?: number }

export type PendingReferenceError = 'duplicate' | 'too_many' | 'total_too_large'

export type PendingReferenceResult =
  | { ok: true; pending: MessageReferenceSnapshot[] }
  | { ok: false; error: PendingReferenceError }

/** True only for strictly older context epochs — current-epoch items stay in live history. */
export function isReferenceableFromEpoch(
  sourceEpoch: number | undefined,
  currentEpoch: number,
): boolean {
  if (sourceEpoch === undefined) return false
  return sourceEpoch < currentEpoch
}

export function createMessageReference(
  source: ReferenceableMessage,
  options: {
    currentEpoch: number
    now?: string
    id?: string
    charRange?: { start: number; end: number }
  },
): CreateReferenceResult {
  if (source.role === 'system') {
    return { ok: false, error: 'not_referenceable_role' }
  }
  if (!isReferenceableFromEpoch(source.contextEpoch, options.currentEpoch)) {
    return { ok: false, error: 'same_or_newer_epoch' }
  }

  const raw = source.content ?? ''
  if (!raw.trim()) {
    return { ok: false, error: 'empty_content' }
  }

  const maxChars = source.role === 'tool'
    ? MAX_TOOL_REFERENCE_CHARS
    : MAX_MESSAGE_REFERENCE_CHARS

  let contentSnapshot = raw
  let truncated = false
  let charRange = options.charRange

  if (charRange) {
    const start = Math.max(0, Math.floor(charRange.start))
    const end = Math.max(start, Math.floor(charRange.end))
    if (start >= raw.length || end <= start) {
      return { ok: false, error: 'invalid_range' }
    }
    contentSnapshot = raw.slice(start, end)
    truncated = start > 0 || end < raw.length
    charRange = { start, end: Math.min(end, raw.length) }
    if (contentSnapshot.length > maxChars) {
      return {
        ok: false,
        error: source.role === 'tool' ? 'tool_output_too_large' : 'message_too_large',
        maxChars,
      }
    }
  } else if (raw.length > maxChars) {
    return {
      ok: false,
      error: source.role === 'tool' ? 'tool_output_too_large' : 'message_too_large',
      maxChars,
    }
  }

  if (!contentSnapshot.trim()) {
    return { ok: false, error: 'empty_content' }
  }

  const now = options.now ?? new Date().toISOString()
  return {
    ok: true,
    reference: {
      id: options.id ?? crypto.randomUUID(),
      sourceMessageId: source.id,
      sourceEpoch: source.contextEpoch!,
      role: source.role,
      createdAt: source.createdAt ?? now,
      referencedAt: now,
      contentSnapshot,
      truncated,
      ...(charRange ? { charRange } : {}),
    },
  }
}

export function addPendingReference(
  pending: readonly MessageReferenceSnapshot[],
  reference: MessageReferenceSnapshot,
): PendingReferenceResult {
  if (pending.some((item) => item.id === reference.id || item.sourceMessageId === reference.sourceMessageId)) {
    return { ok: false, error: 'duplicate' }
  }
  if (pending.length >= MAX_PENDING_REFERENCES) {
    return { ok: false, error: 'too_many' }
  }
  const totalChars = pending.reduce((sum, item) => sum + item.contentSnapshot.length, 0)
    + reference.contentSnapshot.length
  if (totalChars > MAX_PENDING_REFERENCE_TOTAL_CHARS) {
    return { ok: false, error: 'total_too_large' }
  }
  return { ok: true, pending: [...pending, reference] }
}

export function removePendingReference(
  pending: readonly MessageReferenceSnapshot[],
  referenceId: string,
): MessageReferenceSnapshot[] {
  return pending.filter((item) => item.id !== referenceId)
}

/** Serialize frozen quotes for ContextAssembler / model delivery. */
export function formatUserQuotesForAgent(
  references: readonly MessageReferenceSnapshot[],
): string {
  if (references.length === 0) return ''
  return references.map((reference, index) => {
    const range = reference.charRange
      ? ` chars ${reference.charRange.start}-${reference.charRange.end}`
      : ''
    const truncated = reference.truncated ? ' (truncated)' : ''
    return [
      `[Quoted message ${index + 1}]`,
      `source message id: ${reference.sourceMessageId}`,
      `source epoch ${reference.sourceEpoch}`,
      `role: ${reference.role}`,
      `created at: ${reference.createdAt}`,
      `content${range}${truncated}:`,
      reference.contentSnapshot,
    ].join('\n')
  }).join('\n\n')
}

/** IPC payload derived from a frozen renderer snapshot. */
export function toAgentChatQuote(reference: MessageReferenceSnapshot): {
  sourceMessageId: string
  sourceEpoch: number
  role: ReferenceableRole
  createdAt: string
  contentSnapshot: string
  truncated?: boolean
  charRange?: { start: number; end: number }
} {
  return {
    sourceMessageId: reference.sourceMessageId,
    sourceEpoch: reference.sourceEpoch,
    role: reference.role,
    createdAt: reference.createdAt,
    contentSnapshot: reference.contentSnapshot,
    ...(reference.truncated ? { truncated: true } : {}),
    ...(reference.charRange ? { charRange: reference.charRange } : {}),
  }
}
