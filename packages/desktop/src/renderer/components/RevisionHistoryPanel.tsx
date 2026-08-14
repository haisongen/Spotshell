import { useCallback, useEffect, useMemo, useState } from 'react'
import { Diff, History, RotateCcw, Trash2 } from 'lucide-react'
import type {
  RevisionCleanupPreview,
  RevisionComparison,
  RevisionHistoryEntry,
} from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

interface RevisionHistoryPanelProps {
  objectId: string
  /** Bump after publish/restore so the panel reloads. */
  refreshToken?: number
  onRestored?: () => void | Promise<void>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

async function collectAgentActiveRevisions(objectId: string): Promise<number[]> {
  try {
    const sessions = await window.spotshell.listSessions()
    const revisions = new Set<number>()
    for (const session of sessions) {
      for (const pin of session.activeRevisions) {
        if (pin.objectId === objectId) revisions.add(pin.revision)
      }
    }
    return [...revisions].sort((a, b) => a - b)
  } catch {
    return []
  }
}

export function RevisionHistoryPanel({
  objectId,
  refreshToken = 0,
  onRestored,
}: RevisionHistoryPanelProps): JSX.Element {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<RevisionHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [compareLeft, setCompareLeft] = useState<number | null>(null)
  const [compareRight, setCompareRight] = useState<number | null>(null)
  const [comparison, setComparison] = useState<RevisionComparison | null>(null)
  const [cleanupPreview, setCleanupPreview] = useState<RevisionCleanupPreview | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setMessage(null)
    try {
      const agentActiveRevisions = await collectAgentActiveRevisions(objectId)
      const history = await window.spotshell.listKnowledgeRevisions({
        id: objectId,
        agentActiveRevisions,
      })
      setEntries(history)
      setSelected((current) => {
        const available = new Set(history.map((entry) => entry.revision))
        return new Set([...current].filter((revision) => available.has(revision)))
      })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [objectId])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const selectedList = useMemo(
    () => [...selected].sort((a, b) => a - b),
    [selected],
  )

  function toggleSelected(revision: number): void {
    setCleanupPreview(null)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(revision)) next.delete(revision)
      else next.add(revision)
      return next
    })
  }

  async function runCompare(): Promise<void> {
    if (compareLeft === null || compareRight === null) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.spotshell.compareKnowledgeRevisions({
        id: objectId,
        leftRevision: compareLeft,
        rightRevision: compareRight,
      })
      setComparison(result)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setComparison(null)
    } finally {
      setBusy(false)
    }
  }

  async function runRestore(revision: number): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const restored = await window.spotshell.restoreKnowledgeRevision({
        id: objectId,
        revision,
      })
      setMessage(t('revisionRestored', { from: revision, revision: restored.revision }))
      await onRestored?.()
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function previewCleanup(): Promise<void> {
    if (selectedList.length === 0) return
    setBusy(true)
    setMessage(null)
    try {
      const agentActiveRevisions = await collectAgentActiveRevisions(objectId)
      const preview = await window.spotshell.previewKnowledgeRevisionCleanup({
        id: objectId,
        revisions: selectedList,
        agentActiveRevisions,
      })
      setCleanupPreview(preview)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setCleanupPreview(null)
    } finally {
      setBusy(false)
    }
  }

  async function confirmCleanup(): Promise<void> {
    if (!cleanupPreview || cleanupPreview.removableRevisions.length === 0) return
    setBusy(true)
    setMessage(null)
    try {
      const agentActiveRevisions = await collectAgentActiveRevisions(objectId)
      const result = await window.spotshell.cleanupKnowledgeRevisions({
        id: objectId,
        revisions: cleanupPreview.removableRevisions,
        agentActiveRevisions,
      })
      setMessage(t('revisionCleanupDone', {
        count: result.removedRevisions.length,
        bytes: formatBytes(result.freedBytes),
      }))
      setCleanupPreview(null)
      setSelected(new Set())
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <p className="muted knowledge-list-state">{t('loading')}</p>
  }

  if (entries.length === 0) {
    return (
      <div className="revision-history-empty">
        <History size={22} aria-hidden="true" />
        <p>{t('revisionHistoryEmpty')}</p>
      </div>
    )
  }

  return (
    <div className="revision-history-panel" aria-label={t('revisionHistoryTitle')}>
      <div className="revision-history-toolbar">
        <div className="revision-history-compare">
          <label>
            <span>{t('revisionCompareLeft')}</span>
            <select
              value={compareLeft ?? ''}
              onChange={(event) => {
                setComparison(null)
                setCompareLeft(event.target.value ? Number(event.target.value) : null)
              }}
            >
              <option value="">{t('revisionSelect')}</option>
              {entries.map((entry) => (
                <option key={`left-${entry.revision}`} value={entry.revision}>
                  r{entry.revision}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('revisionCompareRight')}</span>
            <select
              value={compareRight ?? ''}
              onChange={(event) => {
                setComparison(null)
                setCompareRight(event.target.value ? Number(event.target.value) : null)
              }}
            >
              <option value="">{t('revisionSelect')}</option>
              {entries.map((entry) => (
                <option key={`right-${entry.revision}`} value={entry.revision}>
                  r{entry.revision}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || compareLeft === null || compareRight === null || compareLeft === compareRight}
            onClick={() => { void runCompare() }}
          >
            <Diff size={14} aria-hidden="true" />
            {t('revisionCompare')}
          </button>
        </div>
        <div className="revision-history-cleanup-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || selectedList.length === 0}
            onClick={() => { void previewCleanup() }}
          >
            <Trash2 size={14} aria-hidden="true" />
            {t('revisionCleanupPreview')}
          </button>
        </div>
      </div>

      {message ? <p className="knowledge-inline-message" role="status">{message}</p> : null}

      {cleanupPreview ? (
        <div className="revision-cleanup-preview" role="dialog" aria-label={t('revisionCleanupPreview')}>
          <strong>{t('revisionCleanupPreviewTitle')}</strong>
          <p>
            {t('revisionCleanupPreviewDetail', {
              removable: cleanupPreview.removableRevisions.join(', ') || '—',
              blocked: cleanupPreview.blockedRevisions
                .map((entry) => `r${entry.revision}`)
                .join(', ') || '—',
              bytes: formatBytes(cleanupPreview.estimatedFreedBytes),
            })}
          </p>
          <p className="muted">{t('revisionCleanupIrreversible')}</p>
          <div className="revision-cleanup-preview-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => setCleanupPreview(null)}
            >
              {t('knowledgeImportCancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || cleanupPreview.removableRevisions.length === 0}
              onClick={() => { void confirmCleanup() }}
            >
              {t('revisionCleanupConfirm')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="revision-history-list" role="list">
        {entries.map((entry) => {
          const protectedReasons = entry.protectionReasons
          const canSelectForCleanup = protectedReasons.length === 0
          return (
            <div
              key={entry.revision}
              className={`revision-history-row${entry.isCurrentEffective ? ' current' : ''}`}
              role="listitem"
            >
              <label className="revision-history-select">
                <input
                  type="checkbox"
                  checked={selected.has(entry.revision)}
                  disabled={!canSelectForCleanup || busy}
                  onChange={() => toggleSelected(entry.revision)}
                  aria-label={t('revisionSelectForCleanup', { revision: entry.revision })}
                />
              </label>
              <div className="revision-history-meta">
                <div className="revision-history-title-row">
                  <strong>r{entry.revision}</strong>
                  {entry.isCurrentEffective ? (
                    <span className="revision-badge effective">{t('revisionCurrentEffective')}</span>
                  ) : null}
                  {entry.isAgentActive ? (
                    <span className="revision-badge active">{t('revisionAgentActive')}</span>
                  ) : null}
                  {protectedReasons.length > 0 && !entry.isCurrentEffective && !entry.isAgentActive ? (
                    <span className="revision-badge protected">{t('revisionProtected')}</span>
                  ) : null}
                </div>
                <div className="revision-history-details muted">
                  <span>{formatTime(entry.createdAt)}</span>
                  <span title={entry.origin}>{t('revisionOrigin', { origin: entry.origin })}</span>
                  <code title={entry.contentHash}>{entry.contentHash.slice(0, 10)}</code>
                  <span>{formatBytes(entry.sizeBytes)}</span>
                </div>
              </div>
              <div className="revision-history-row-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy || entry.isCurrentEffective}
                  title={entry.isCurrentEffective ? t('revisionAlreadyCurrent') : t('revisionRestore')}
                  onClick={() => { void runRestore(entry.revision) }}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  {t('revisionRestore')}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {comparison ? (
        <div className="revision-comparison" aria-label={t('revisionCompare')}>
          <strong>
            {t('revisionCompareResult', {
              left: comparison.leftRevision,
              right: comparison.rightRevision,
            })}
          </strong>
          <p className="muted">
            {comparison.entryChanged
              ? t('revisionEntryChanged')
              : t('revisionEntryUnchanged')}
          </p>
          <ul className="revision-comparison-files">
            {comparison.files
              .filter((file) => file.change !== 'unchanged')
              .map((file) => (
                <li key={file.relativePath}>
                  <code>{file.relativePath}</code>
                  <span className={`revision-change ${file.change}`}>
                    {t(`revisionChange_${file.change}` as 'revisionChange_added')}
                  </span>
                </li>
              ))}
          </ul>
          {comparison.files.every((file) => file.change === 'unchanged') ? (
            <p className="muted">{t('revisionNoFileDiffs')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
