import { useEffect, useRef } from 'react'
import type { CloseOtherSessionsSnapshot } from '../sessionTabActions'
import { useTranslation } from '../i18n'

interface ConfirmCloseOtherSessionsModalProps {
  snapshot: CloseOtherSessionsSnapshot | null
  busy: boolean
  onCancel: () => void
  onConfirm: (snapshot: CloseOtherSessionsSnapshot) => void
}

export function ConfirmCloseOtherSessionsModal(
  props: ConfirmCloseOtherSessionsModalProps
): JSX.Element | null {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!props.snapshot) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    requestAnimationFrame(() => cancelRef.current?.focus())
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
      returnFocusRef.current = null
    }
  }, [props.snapshot])

  useEffect(() => {
    if (!props.snapshot) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !props.busy) props.onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [props.snapshot, props.busy, props.onCancel])

  if (!props.snapshot) return null
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !props.busy) props.onCancel()
    }}>
      <section className="modal close-other-sessions-modal" role="alertdialog" aria-modal="true"
        aria-labelledby="close-other-sessions-title" aria-describedby="close-other-sessions-description">
        <div className="modal-header">
          <h2 id="close-other-sessions-title">{t('closeOtherSessionsTitle')}</h2>
        </div>
        <div className="modal-body">
          <p id="close-other-sessions-description">
            {t('closeOtherSessionsPrompt', { count: props.snapshot.closeSessionIds.length })}
          </p>
          <div className="modal-actions">
            <button ref={cancelRef} type="button" className="btn btn-ghost" disabled={props.busy}
              onClick={props.onCancel}>{t('cancel')}</button>
            <button type="button" className="btn btn-danger" disabled={props.busy}
              onClick={() => props.onConfirm(props.snapshot!)}>
              {props.busy ? t('closingSessions') : t('closeOtherSessions')}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
