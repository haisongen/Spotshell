import { useEffect, useRef } from 'react'
import { useTranslation } from '../i18n'

export interface CloseSessionTarget {
  id: string
  title: string
}

interface ConfirmCloseSessionModalProps {
  session: CloseSessionTarget | null
  onCancel: () => void
  onConfirm: (session: CloseSessionTarget) => void
}

export function ConfirmCloseSessionModal({
  session, onCancel, onConfirm,
}: ConfirmCloseSessionModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!session) return
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    requestAnimationFrame(() => cancelRef.current?.focus())
    return () => {
      const target = returnFocusRef.current
      returnFocusRef.current = null
      if (target?.isConnected) target.focus()
    }
  }, [session?.id])

  useEffect(() => {
    if (!session) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [session, onCancel])

  if (!session) return null
  return (
    <div className={'modal-backdrop close-session-backdrop'} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <section className={'modal close-session-modal'} role={'alertdialog'} aria-modal={true}
        aria-labelledby={'close-session-title'} aria-describedby={'close-session-description'}>
        <div className={'modal-header'}>
          <h2 id={'close-session-title'}>{t('closeConnectionTitle')}</h2>
        </div>
        <div className={'modal-body'}>
          <p id={'close-session-description'} className={'close-session-description'}>
            {t('closeConnectionPrompt', { name: session.title })}
          </p>
          <div className={'modal-actions'}>
            <button ref={cancelRef} type={'button'} className={'btn btn-ghost'}
              onClick={onCancel}>{t('cancel')}</button>
            <button type={'button'} className={'btn btn-close-danger'}
              onClick={() => onConfirm(session)}>
              {t('closeConnectionConfirm')}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
