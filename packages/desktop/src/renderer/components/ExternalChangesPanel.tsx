import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, FolderOpen, RefreshCw } from 'lucide-react'
import type { ExternalChangePreview } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

export interface ExternalChangesModel {
  busy: boolean
  status: ExternalChangePreview | null
  pending: boolean
  statusLabel: string
  hintText: string
  openFolder: () => Promise<void>
  refresh: () => Promise<void>
  adopt: () => Promise<void>
  discard: () => Promise<void>
}

interface UseExternalChangesOptions {
  objectId: string | null
  refreshToken?: number
  onAdopted?: (revision: number) => void
  onMessage?: (message: string | null) => void
}

/** Shared external-edit state for detail header actions + optional review panel. */
export function useExternalChanges({
  objectId,
  refreshToken = 0,
  onAdopted,
  onMessage,
}: UseExternalChangesOptions): ExternalChangesModel {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ExternalChangePreview | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!objectId) return
    try {
      const next = await window.spotshell.previewExternalChanges(objectId)
      setStatus(next)
    } catch (error) {
      onMessage?.(errorMessage(error))
    }
  }, [objectId, onMessage])

  useEffect(() => {
    if (!objectId) {
      setStatus(null)
      return
    }
    let cancelled = false
    setStatus(null)
    void window.spotshell.previewExternalChanges(objectId)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) onMessage?.(errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [objectId, refreshToken, onMessage])

  useEffect(() => {
    if (!objectId) return
    return window.spotshell.onExternalChanges((statuses) => {
      const match = statuses.find((item) => item.id === objectId)
      if (match) {
        setStatus({
          ...match,
          canAdopt: match.status === 'pending' && match.validationErrors.length === 0,
        })
      }
    })
  }, [objectId])

  const openFolder = useCallback(async (): Promise<void> => {
    if (!objectId) return
    setBusy(true)
    onMessage?.(null)
    try {
      await window.spotshell.openManagedObjectRoot(objectId)
      await refresh()
    } catch (error) {
      onMessage?.(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }, [objectId, onMessage, refresh])

  const adopt = useCallback(async (): Promise<void> => {
    if (!objectId) return
    setBusy(true)
    onMessage?.(null)
    try {
      const revision = await window.spotshell.adoptExternalChanges(objectId)
      await refresh()
      onAdopted?.(revision.revision)
      onMessage?.(t('externalChangesAdopted', { revision: revision.revision }))
    } catch (error) {
      onMessage?.(errorMessage(error))
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [objectId, onAdopted, onMessage, refresh, t])

  const discard = useCallback(async (): Promise<void> => {
    if (!objectId) return
    setBusy(true)
    onMessage?.(null)
    try {
      const next = await window.spotshell.discardExternalChanges(objectId)
      setStatus({
        ...next,
        canAdopt: next.status === 'pending' && next.validationErrors.length === 0,
      })
      onMessage?.(t('externalChangesDiscarded'))
    } catch (error) {
      onMessage?.(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }, [objectId, onMessage, t])

  const statusLabel = !status
    ? t('externalChangesTitle')
    : status.status === 'clean'
      ? t('externalChangesClean')
      : status.status === 'invalid'
        ? t('externalChangesInvalid')
        : t('externalChangesPending')

  return {
    busy,
    status,
    pending: Boolean(status && status.status !== 'clean'),
    statusLabel,
    hintText: t('externalChangesHint'),
    openFolder,
    refresh,
    adopt,
    discard,
  }
}

interface ExternalChangesHeaderActionsProps {
  model: ExternalChangesModel
  disabled?: boolean
}

/** Folder / rescan / info control for the detail header action row. */
export function ExternalChangesHeaderActions({
  model,
  disabled = false,
}: ExternalChangesHeaderActionsProps): JSX.Element {
  const { t } = useTranslation()
  const inactive = disabled || model.busy

  return (
    <div className="external-changes-header-actions">
      <span
        className={`external-changes-info${model.pending ? ' pending' : ''}`}
        tabIndex={0}
        role="img"
        aria-label={`${model.statusLabel}. ${model.hintText}`}
      >
        <CircleAlert size={15} aria-hidden="true" />
        <span className="external-changes-tooltip" role="tooltip">
          <strong>{model.statusLabel}</strong>
          <span>{model.hintText}</span>
        </span>
      </span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={inactive}
        title={t('externalChangesOpenFolder')}
        onClick={() => { void model.openFolder() }}
      >
        <FolderOpen size={14} aria-hidden="true" />
        {t('externalChangesOpenFolder')}
      </button>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={inactive}
        title={t('externalChangesRescan')}
        onClick={() => { void model.refresh() }}
      >
        <RefreshCw size={14} aria-hidden="true" />
        {t('externalChangesRescan')}
      </button>
    </div>
  )
}

interface ExternalChangesReviewPanelProps {
  model: ExternalChangesModel
  disabled?: boolean
}

/** Pending/invalid external edits: file list, validation, adopt/discard. Hidden when clean. */
export function ExternalChangesReviewPanel({
  model,
  disabled = false,
}: ExternalChangesReviewPanelProps): JSX.Element | null {
  const { t } = useTranslation()
  const { status, pending, busy } = model
  if (!status || !pending) return null

  const inactive = disabled || busy

  return (
    <section
      className="knowledge-external-panel"
      aria-label={t('externalChangesTitle')}
    >
      <div className="knowledge-external-panel-header">
        <strong>{model.statusLabel}</strong>
        <CircleAlert size={15} aria-hidden="true" />
      </div>

      {status.files.length > 0 ? (
        <ul className="knowledge-module-list">
          {status.files.map((file) => (
            <li key={`${file.change}:${file.previousPath ?? ''}:${file.relativePath}`}>
              {file.change === 'renamed'
                ? t('externalChangesFileRenamed', {
                    from: file.previousPath ?? '?',
                    to: file.relativePath,
                  })
                : t('externalChangesFileChange', {
                    change: changeLabel(t, file.change),
                    path: file.relativePath,
                  })}
            </li>
          ))}
        </ul>
      ) : null}

      {status.validationErrors.length > 0 ? (
        <ul className="knowledge-module-list">
          {status.validationErrors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      <div className="knowledge-detail-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={inactive || !status.latestRevision}
          onClick={() => { void model.discard() }}
        >
          {t('externalChangesDiscard')}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={
            inactive
            || status.status !== 'pending'
            || status.validationErrors.length > 0
          }
          onClick={() => { void model.adopt() }}
        >
          {t('externalChangesAdopt')}
        </button>
      </div>
    </section>
  )
}

function changeLabel(
  t: ReturnType<typeof useTranslation>['t'],
  change: string,
): string {
  if (change === 'added') return t('externalChangesChange_added')
  if (change === 'removed') return t('externalChangesChange_removed')
  if (change === 'modified') return t('externalChangesChange_modified')
  if (change === 'renamed') return t('externalChangesChange_renamed')
  return change
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
