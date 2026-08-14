import fs from 'node:fs'
import path from 'node:path'
import {
  EXTERNAL_EDIT_DEBOUNCE_MS,
  shouldIgnoreExternalWatchEvent,
  type ExternalChangeStatus,
  type KnowledgeRepository,
} from '@spotshell/core'

const OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ExternalChangeListener = (statuses: ExternalChangeStatus[]) => void

/**
 * Watches the knowledge repository root for external editor writes.
 * Debounces bursts and ignores temporary editor files / system dirs.
 */
export class ExternalEditWatcher {
  private watcher: fs.FSWatcher | null = null
  private readonly pendingIds = new Set<string>()
  private debounceTimer: NodeJS.Timeout | null = null
  private scanning = false
  private closed = false
  private readonly listeners = new Set<ExternalChangeListener>()

  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly rootPath: string,
    private readonly debounceMs: number = EXTERNAL_EDIT_DEBOUNCE_MS,
  ) {}

  onChange(listener: ExternalChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.watcher || this.closed) return
    fs.mkdirSync(this.rootPath, { recursive: true })
    try {
      this.watcher = fs.watch(
        this.rootPath,
        { recursive: true },
        (_eventType, filename) => {
          if (this.closed || !filename) return
          const relative = filename.toString().replace(/\\/g, '/')
          if (shouldIgnoreExternalWatchEvent(relative)) return
          const objectId = relative.split('/')[0]
          if (!objectId || !OBJECT_ID_RE.test(objectId)) return
          // Only content under draft-files (or SPACE.md writes there) matter.
          if (!relative.includes('/draft-files/') && !relative.endsWith('/draft-files')) {
            return
          }
          this.pendingIds.add(objectId)
          this.scheduleFlush()
        },
      )
    } catch {
      // Some environments disallow recursive watches; startup scan still covers cold start.
      this.watcher = null
    }
  }

  async scanAllNow(): Promise<ExternalChangeStatus[]> {
    const statuses = await this.repository.scanAllExternalChanges()
    this.emit(statuses)
    return statuses
  }

  stop(): void {
    this.closed = true
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.watcher?.close()
    this.watcher = null
    this.pendingIds.clear()
    this.listeners.clear()
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.flush()
    }, this.debounceMs)
  }

  private async flush(): Promise<void> {
    if (this.scanning || this.closed) return
    const ids = [...this.pendingIds]
    this.pendingIds.clear()
    if (ids.length === 0) return
    this.scanning = true
    try {
      const statuses: ExternalChangeStatus[] = []
      for (const id of ids) {
        try {
          statuses.push(await this.repository.scanExternalChanges(id))
        } catch {
          // Object may have been deleted while the write settled.
        }
      }
      if (statuses.length > 0) this.emit(statuses)
    } finally {
      this.scanning = false
      if (this.pendingIds.size > 0) this.scheduleFlush()
    }
  }

  private emit(statuses: ExternalChangeStatus[]): void {
    for (const listener of this.listeners) {
      try {
        listener(statuses)
      } catch {
        // Listener errors must not stop the watcher.
      }
    }
  }
}

/** Resolve object id from an absolute path under the knowledge root. */
export function objectIdFromKnowledgePath(rootPath: string, absolutePath: string): string | null {
  const relative = path.relative(rootPath, absolutePath).replace(/\\/g, '/')
  if (!relative || relative.startsWith('..')) return null
  const objectId = relative.split('/')[0]
  return objectId && OBJECT_ID_RE.test(objectId) ? objectId : null
}
