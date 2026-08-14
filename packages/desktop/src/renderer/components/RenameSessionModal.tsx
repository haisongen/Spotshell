import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n'

export interface RenameSessionTarget {
  id: string
  title: string
}

interface RenameSessionModalProps {
  session: RenameSessionTarget | null
  onCancel: () => void
  onSubmit: (sessionId: string, title: string) => Promise<void>
}

export function RenameSessionModal(props: RenameSessionModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!props.session) return
    setTitle(props.session.title)
    setError(null)
    setBusy(false)
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    requestAnimationFrame(() => inputRef.current?.select())
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
      returnFocusRef.current = null
    }
  }, [props.session?.id])

  useEffect(() => {
    if (!props.session) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) props.onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [props.session, busy, props.onCancel])

  if (!props.session) return null
  const trimmed = title.trim()
  const validationError = trimmed.length === 0
    ? t('sessionTitleRequired')
    : Array.from(trimmed).length > 80
      ? t('sessionTitleTooLong')
      : null

  const submit = async (): Promise<void> => {
    if (validationError || busy) return
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit(props.session!.id, trimmed)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) props.onCancel()
    }}>
      <section className="modal rename-session-modal" role="dialog" aria-modal="true"
        aria-labelledby="rename-session-title">
        <div className="modal-header"><h2 id="rename-session-title">{t('renameSession')}</h2></div>
        <form className="modal-body" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <label className="session-title-field">
            <span>{t('sessionTitle')}</span>
            <input ref={inputRef} value={title} disabled={busy}
              onChange={(event) => { setTitle(event.target.value); setError(null) }} />
          </label>
          {validationError || error ? <p className="form-error" role="alert">{validationError ?? error}</p> : null}
          <div className="modal-actions">
            <button ref={cancelRef} type="button" className="btn btn-ghost" disabled={busy}
              onClick={props.onCancel}>{t('cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={Boolean(validationError) || busy}>
              {busy ? t('saving') : t('renameSession')}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
