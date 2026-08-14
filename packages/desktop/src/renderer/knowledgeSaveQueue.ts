import type { KnowledgeModuleFormDraft } from '../shared/ipc-types'

/** Detail editor tabs in knowledge / environment workspaces. */
export type KnowledgeEditorMode = 'form' | 'source' | 'files' | 'history'

/** Modes that autosave SPACE.md drafts (not managed-file tab). */
export type KnowledgeDraftSaveMode = 'form' | 'source'

export interface KnowledgeDraftSave {
  moduleId: string
  mode: KnowledgeDraftSaveMode
  form?: KnowledgeModuleFormDraft
  source?: string
  sequence: number
}

interface SequencedDraftSave {
  sequence: number
}

type PendingDraftSave<TSave extends SequencedDraftSave> = Omit<TSave, 'sequence'>
type SaveDraft<TDetail, TSave extends SequencedDraftSave> = (save: TSave) => Promise<TDetail>

export class DraftSaveQueue<TDetail, TSave extends SequencedDraftSave> {
  private pending: TSave | null = null
  private drainPromise: Promise<TDetail | null> | null = null
  private sequence = 0

  constructor(private readonly save: SaveDraft<TDetail, TSave>) {}

  schedule(save: PendingDraftSave<TSave>): void {
    this.pending = { ...save, sequence: ++this.sequence } as TSave
  }

  hasWork(): boolean {
    return this.pending !== null || this.drainPromise !== null
  }

  flush(): Promise<TDetail | null> {
    if (!this.drainPromise) {
      const drain = this.drain().finally(() => {
        if (this.drainPromise === drain) this.drainPromise = null
      })
      this.drainPromise = drain
    }
    return this.drainPromise.then((saved) => this.pending ? this.flush() : saved)
  }

  private async drain(): Promise<TDetail | null> {
    let saved: TDetail | null = null
    while (this.pending) {
      const current = this.pending
      this.pending = null
      try {
        saved = await this.save(current)
      } catch (error) {
        if (!this.pending) this.pending = current
        throw error
      }
    }
    return saved
  }
}
