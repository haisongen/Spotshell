interface PendingRequest {
  sessionId: string
  optionCount: number
  resolve: (outcome: PendingChoiceOutcome) => void
  timer: NodeJS.Timeout
}

export type PendingChoiceStatus =
  /** User picked one of the offered options. */
  | 'answered'
  /** User explicitly declined every option. */
  | 'dismissed'
  /** No answer before the deadline. */
  | 'expired'
  /** Session closed or the turn was cancelled while waiting. */
  | 'cancelled'

export interface PendingChoiceOutcome {
  status: PendingChoiceStatus
  /** Index into the offered options; only set when status is `answered`. */
  optionIndex?: number
}

/**
 * Pending single-choice question registry.
 *
 * Mirrors {@link PendingConfirms} but carries which option was picked, which the
 * approve/reject shape cannot express. Kept separate rather than making
 * PendingConfirms generic: that class has four call sites and its own tests, and
 * a payload-carrying variant would widen all of them for one new caller.
 */
export class PendingChoices {
  private pending = new Map<string, PendingRequest>()
  private completed = new Map<string, PendingChoiceStatus>()

  constructor(private timeoutMs: number) {}

  create(sessionId: string, requestId: string, optionCount: number): Promise<PendingChoiceOutcome> {
    return new Promise<PendingChoiceOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, { status: 'expired' }), this.timeoutMs)
      this.pending.set(requestId, { sessionId, optionCount, resolve, timer })
    })
  }

  /**
   * Record the user's answer. `optionIndex` of null means "none of these".
   * Out-of-range indexes are refused so a malformed IPC payload cannot resolve
   * the wait with a choice the card never offered.
   */
  respond(requestId: string, optionIndex: number | null): { accepted: boolean; status?: PendingChoiceStatus } {
    const entry = this.pending.get(requestId)
    if (!entry) return { accepted: false, status: this.completed.get(requestId) }
    if (optionIndex === null) {
      return { accepted: this.settle(requestId, { status: 'dismissed' }), status: 'dismissed' }
    }
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= entry.optionCount) {
      return { accepted: false }
    }
    return {
      accepted: this.settle(requestId, { status: 'answered', optionIndex }),
      status: 'answered',
    }
  }

  settle(requestId: string, outcome: PendingChoiceOutcome): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    this.rememberCompleted(requestId, outcome.status)
    entry.resolve(outcome)
    return true
  }

  rejectForSession(sessionId: string): string[] {
    const rejected: string[] = []
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionId === sessionId && this.settle(requestId, { status: 'cancelled' })) {
        rejected.push(requestId)
      }
    }
    return rejected
  }

  private rememberCompleted(requestId: string, status: PendingChoiceStatus): void {
    this.completed.set(requestId, status)
    if (this.completed.size > 1_000) {
      const oldest = this.completed.keys().next().value
      if (oldest) this.completed.delete(oldest)
    }
  }
}
