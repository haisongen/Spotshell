interface PendingRequest {
  sessionId: string
  resolve: (outcome: PendingConfirmOutcome) => void
  timer: NodeJS.Timeout
}

export type PendingConfirmStatus = 'approved' | 'rejected' | 'cancelled' | 'expired'

export interface PendingConfirmOutcome {
  ok: boolean
  status: PendingConfirmStatus
}

/** Pending confirmation registry that fails closed on timeout or session close. */
export class PendingConfirms {
  private pending = new Map<string, PendingRequest>()
  private completed = new Map<string, PendingConfirmStatus>()

  constructor(private timeoutMs: number) {}

  create(sessionId: string, requestId: string): Promise<PendingConfirmOutcome> {
    return new Promise<PendingConfirmOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, 'expired'), this.timeoutMs)
      this.pending.set(requestId, { sessionId, resolve, timer })
    })
  }

  respond(requestId: string, ok: boolean): boolean {
    return this.settle(requestId, ok ? 'approved' : 'rejected')
  }

  respondWithStatus(
    requestId: string,
    ok: boolean
  ): { accepted: boolean; status?: PendingConfirmStatus } {
    const status = ok ? 'approved' : 'rejected'
    if (this.settle(requestId, status)) return { accepted: true, status }
    return { accepted: false, status: this.completed.get(requestId) }
  }

  settle(requestId: string, status: PendingConfirmStatus): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    this.rememberCompleted(requestId, status)
    entry.resolve({ ok: status === 'approved', status })
    return true
  }

  rejectForSession(sessionId: string): string[] {
    const rejected: string[] = []
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionId === sessionId && this.settle(requestId, 'cancelled')) {
        rejected.push(requestId)
      }
    }
    return rejected
  }

  private rememberCompleted(requestId: string, status: PendingConfirmStatus): void {
    this.completed.set(requestId, status)
    if (this.completed.size > 1_000) {
      const oldest = this.completed.keys().next().value
      if (oldest) this.completed.delete(oldest)
    }
  }
}
