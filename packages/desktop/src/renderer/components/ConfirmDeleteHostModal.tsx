import { useEffect, useRef } from 'react'
import type { SavedHostProfile } from '../../shared/ipc-types'
import { formatHostTarget } from '../hostManagement'
import { useTranslation } from '../i18n'

interface ConfirmDeleteHostModalProps {
  host: SavedHostProfile | null
  busy?: boolean
  onCancel: () => void
  onConfirm: (host: SavedHostProfile) => void
}

export function ConfirmDeleteHostModal({
  host, busy = false, onCancel, onConfirm,
}: ConfirmDeleteHostModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!host) return
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    requestAnimationFrame(() => cancelRef.current?.focus())
    return () => {
      const target = returnFocusRef.current
      returnFocusRef.current = null
      if (target?.isConnected) target.focus()
    }
  }, [host?.id])

  useEffect(() => {
    if (!host) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [host, busy, onCancel])

  if (!host) return null
  return (
    <div className={'modal-backdrop delete-host-backdrop'} onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel()
    }}>
      <section className={'modal delete-host-modal'} role={'alertdialog'} aria-modal={true}
        aria-labelledby={'delete-host-title'} aria-describedby={'delete-host-description'}>
        <div className={'modal-header'}>
          <h2 id={'delete-host-title'}>{t('deleteHostTitle')}</h2>
        </div>
        <div className={'modal-body'}>
          <p id={'delete-host-description'} className={'delete-host-description'}>
            {t('deleteHostPrompt', { name: host.name, target: formatHostTarget(host) })}
          </p>
          <div className={'delete-host-target'}>
            <strong>{host.name}</strong><span>{formatHostTarget(host)}</span>
          </div>
          <div className={'modal-actions'}>
            <button ref={cancelRef} type={'button'} className={'btn btn-ghost'}
              disabled={busy} onClick={onCancel}>{t('cancel')}</button>
            <button type={'button'} className={'btn btn-danger'} disabled={busy}
              onClick={() => onConfirm(host)}>
              {t('deleteHostConfirm')}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
