import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react'
import type {
  PermanentDeletePreview,
  TrashEntryDetail,
  TrashEntrySummary,
} from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

export interface TrashRestoredEvent {
  id: string
  kind: 'environment' | 'knowledge'
  name: string
}

export function TrashWorkspace({
  active,
  onRestored,
}: {
  active: boolean
  /** Fired after a successful restore so sibling catalogs can reload. */
  onRestored?: (event: TrashRestoredEvent) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<TrashEntrySummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TrashEntryDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [permanentPreview, setPermanentPreview] = useState<PermanentDeletePreview | null>(null)

  async function refreshList(preferredId?: string | null): Promise<void> {
    const items = await window.spotshell.listTrash()
    setEntries(items)
    setSelectedId((current) => {
      if (preferredId && items.some((item) => item.id === preferredId)) return preferredId
      if (current && items.some((item) => item.id === current)) return current
      return items[0]?.id ?? null
    })
  }

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    void window.spotshell.purgeExpiredTrash()
      .catch(() => undefined)
      .then(() => refreshList())
      .then(() => {
        if (!cancelled) setLoading(false)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage(errorMessage(error))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [active])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    window.spotshell.getTrashEntry(selectedId)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  async function restore(): Promise<void> {
    if (!detail) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.spotshell.restoreFromTrash(detail.id)
      setMessage(t('trashRestored', { name: result.name }))
      setPermanentPreview(null)
      await refreshList(null)
      setDetail(null)
      onRestored?.({
        id: result.id,
        kind: result.kind,
        name: result.name,
      })
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function beginPermanentDelete(): Promise<void> {
    if (!detail) return
    setBusy(true)
    setMessage(null)
    try {
      const preview = await window.spotshell.previewPermanentDelete({ id: detail.id })
      setPermanentPreview(preview)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function confirmPermanentDelete(): Promise<void> {
    if (!detail || !permanentPreview?.canPermanentlyDelete) return
    setBusy(true)
    setMessage(null)
    try {
      const name = detail.name
      await window.spotshell.permanentlyDeleteFromTrash({ id: detail.id })
      setPermanentPreview(null)
      setMessage(t('trashPermanentlyDeleted', { name }))
      await refreshList(null)
      setDetail(null)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function purgeExpired(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.spotshell.purgeExpiredTrash()
      setMessage(t('trashPurged', { count: result.purgedIds.length }))
      await refreshList(selectedId)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <aside className="knowledge-list-pane">
        <div className="knowledge-pane-header">
          <div>
            <h1>{t('trashSection')}</h1>
            <span>{entries.length}</span>
          </div>
          <div className="knowledge-pane-header-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || loading}
              onClick={() => { void purgeExpired() }}
            >
              {t('trashPurgeExpired')}
            </button>
          </div>
        </div>
        <div className="knowledge-module-list" role="listbox" aria-label={t('trashSection')}>
          {loading ? <p className="muted knowledge-list-state">{t('loading')}</p> : null}
          {!loading && entries.length === 0 ? (
            <div className="knowledge-list-state">
              <Trash2 size={22} aria-hidden="true" />
              <p>{t('trashEmpty')}</p>
            </div>
          ) : null}
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={selectedId === entry.id}
              className={`knowledge-module-row${selectedId === entry.id ? ' active' : ''}`}
              disabled={busy}
              onClick={() => setSelectedId(entry.id)}
            >
              <span className="knowledge-module-name">{entry.name}</span>
              <span className="knowledge-module-description">
                {entry.kind === 'knowledge' ? t('trashKindKnowledge') : t('trashKindEnvironment')}
              </span>
              <span className="knowledge-module-version">
                {entry.daysRemaining > 0
                  ? t('trashRetention', {
                      days: entry.daysRemaining,
                      expires: formatDate(entry.expiresAt),
                    })
                  : t('trashExpired')}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="knowledge-detail-pane">
        {!detail ? (
          <div className="knowledge-detail-empty">
            <Trash2 size={28} aria-hidden="true" />
            <p>{t('trashSelect')}</p>
          </div>
        ) : (
          <>
            <header className="knowledge-detail-header">
              <div className="knowledge-detail-title">
                <h2>{detail.name}</h2>
                <div className="knowledge-managed-meta">
                  <code title={detail.id}>{detail.id.slice(0, 8)}</code>
                  <span>
                    {detail.kind === 'knowledge'
                      ? t('trashKindKnowledge')
                      : t('trashKindEnvironment')}
                  </span>
                  {detail.latestRevision ? (
                    <span>{t('knowledgeRevision', { revision: detail.latestRevision })}</span>
                  ) : null}
                  <span>
                    {detail.daysRemaining > 0
                      ? t('trashRetention', {
                          days: detail.daysRemaining,
                          expires: formatDate(detail.expiresAt),
                        })
                      : t('trashExpired')}
                  </span>
                </div>
              </div>
              <div className="knowledge-detail-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => { void restore() }}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {t('trashRestore')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => { void beginPermanentDelete() }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  {t('trashPermanentDelete')}
                </button>
              </div>
            </header>

            {message ? (
              <div className="knowledge-editor-message" role="status">
                <span>{message}</span>
              </div>
            ) : null}

            {permanentPreview ? (
              <section className="knowledge-access-panel" aria-label={t('trashPermanentDeleteTitle')}>
                <div className="knowledge-access-item">
                  <strong>{t('trashPermanentDeleteTitle')}</strong>
                </div>
                <p className="muted">
                  {permanentPreview.canPermanentlyDelete
                    ? t('trashPermanentDeleteConfirm', { name: permanentPreview.name })
                    : t('trashPermanentDeleteBlocked', {
                        reason: permanentPreview.blockers[0]?.message ?? '',
                      })}
                </p>
                <div className="knowledge-detail-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => setPermanentPreview(null)}
                  >
                    {t('knowledgeImportCancel')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy || !permanentPreview.canPermanentlyDelete}
                    onClick={() => { void confirmPermanentDelete() }}
                  >
                    {t('trashPermanentDelete')}
                  </button>
                </div>
              </section>
            ) : null}

            <section className="knowledge-access-panel" aria-label={t('trashSection')}>
              <div className="knowledge-access-item">
                <span>{t('knowledgeDescription')}</span>
                <strong>
                  {t('trashRetention', {
                    days: detail.daysRemaining,
                    expires: formatDate(detail.expiresAt),
                  })}
                </strong>
              </div>
              {detail.kind === 'environment'
                && (detail.referenceSnapshot.associations.always.length > 0
                  || detail.referenceSnapshot.associations.onDemand.length > 0) ? (
                <div className="knowledge-access-item">
                  <span>{t('environmentAssociations')}</span>
                  <strong>
                    {`always: ${detail.referenceSnapshot.associations.always.length}, on_demand: ${detail.referenceSnapshot.associations.onDemand.length}`}
                  </strong>
                </div>
              ) : null}
              {detail.referenceSnapshot.referencedBy.length > 0 ? (
                <div className="knowledge-access-item">
                  <span>{t('knowledgeEnvironmentAlways')}</span>
                  <strong>
                    {detail.referenceSnapshot.referencedBy
                      .map((ref) => `${ref.environmentName} (${ref.mode})`)
                      .join(', ')}
                  </strong>
                </div>
              ) : null}
              {!permanentPreview && detail.daysRemaining === 0 ? (
                <div className="knowledge-editor-message" role="status">
                  <AlertTriangle size={15} aria-hidden="true" />
                  <span>{t('trashExpired')}</span>
                </div>
              ) : null}
            </section>
          </>
        )}
      </div>
    </>
  )
}
