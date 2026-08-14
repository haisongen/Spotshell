import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ConnectRequest, SavedHostProfile } from '../../shared/ipc-types'
import { QuickConnectForm } from './QuickConnectForm'
import { useTranslation } from '../i18n'

interface ConnectionModalProps {
  open: boolean
  host?: SavedHostProfile | null
  busy?: boolean
  onClose: () => void
  onConnect: (req: ConnectRequest) => Promise<void>
}

export function ConnectionModal({
  open,
  host,
  busy,
  onClose,
  onConnect,
}: ConnectionModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      returnFocusRef.current?.focus()
      returnFocusRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setPassword('')
    setError(null)
  }, [open, host?.id])

  if (!open) return null

  async function connectSavedHost(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!host) return
    if (!password) {
      setError(t('connectionPasswordRequired'))
      return
    }

    setError(null)
    const request = onConnect({
        hostId: host.id,
        host: host.host,
        port: host.port,
        username: host.username,
        password,
        privateKeyPath: host.privateKeyPath,
        title: host.name || `${host.username}@${host.host}`,
      })
    onClose()
    await request.catch(() => undefined)
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose()
      }}
    >
      <div
        className="modal connection-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="connection-title">
            {host ? t('connectTo', { name: host.name }) : t('newConnection')}
          </h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('close')}
          </button>
        </header>

        {host ? (
          <form className="modal-body" onSubmit={(e) => void connectSavedHost(e)}>
            <p className="host-connect-target">
              {host.username}@{host.host}:{host.port}
            </p>
            <label className="field">
              <span>{t('password')}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                autoComplete="current-password"
                autoFocus
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                {t('cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? t('connecting') : t('connect')}
              </button>
            </div>
          </form>
        ) : (
          <div className="modal-body">
            <QuickConnectForm
              showHeading={false}
              busy={busy}
              onConnect={(req) => {
                const request = onConnect(req)
                onClose()
                return request
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
