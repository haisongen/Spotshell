import { useState, type FormEvent } from 'react'
import type { ConnectRequest } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

interface QuickConnectFormProps {
  onConnect: (req: ConnectRequest) => Promise<void> | void
  busy?: boolean
  showHeading?: boolean
}

const emptyForm = {
  target: '',
  port: '22',
  authMethod: 'password' as 'password' | 'key',
  privateKeyPath: '',
  password: '',
}

/** Parse user@host (host may be IPv6 in [brackets]). */
function parseTarget(raw: string): { username: string; host: string } | null {
  const value = raw.trim()
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return null
  const username = value.slice(0, at).trim()
  let host = value.slice(at + 1).trim()
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }
  if (!username || !host) return null
  return { username, host }
}

export function QuickConnectForm({
  onConnect,
  busy,
  showHeading = true,
}: QuickConnectFormProps): JSX.Element {
  const { t } = useTranslation()
  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const disabled = Boolean(busy) || submitting

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (disabled) return
    setError(null)

    const parsed = parseTarget(form.target)
    if (!parsed) {
      setError(t('invalidTarget'))
      return
    }

    const port = Number(form.port)
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      setError(t('invalidPort'))
      return
    }

    const privateKeyPath = form.privateKeyPath.trim()
    if (form.authMethod === 'key' && !privateKeyPath) {
      setError(t('privateKeyRequired'))
      return
    }

    if (form.authMethod === 'password' && !form.password) {
      setError(t('passwordAuthRequired'))
      return
    }

    const req: ConnectRequest = {
      host: parsed.host,
      port,
      username: parsed.username,
      password: form.authMethod === 'password' ? form.password : undefined,
      privateKeyPath: form.authMethod === 'key' ? privateKeyPath : undefined,
      title: `${parsed.username}@${parsed.host}`,
    }

    setSubmitting(true)
    try {
      await onConnect(req)
      setForm((f) => ({ ...emptyForm, port: f.port, authMethod: f.authMethod }))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="quick-connect-form" onSubmit={(e) => void handleSubmit(e)}>
      {showHeading ? (
        <>
          <h2>{t('quickConnect')}</h2>
          <p className="hint">{t('quickConnectDescription')}</p>
        </>
      ) : null}

      <label className="field">
        <span>user@host</span>
        <input
          value={form.target}
          onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
          placeholder="root@10.0.0.12"
          disabled={disabled}
          autoComplete="off"
          autoFocus
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>{t('port')}</span>
          <input
            value={form.port}
            onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
            inputMode="numeric"
            disabled={disabled}
          />
        </label>

        <label className="field">
          <span>{t('auth')}</span>
          <select
            value={form.authMethod}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                authMethod: e.target.value as 'password' | 'key',
              }))
            }
            disabled={disabled}
          >
            <option value="password">{t('password')}</option>
            <option value="key">{t('privateKey')}</option>
          </select>
        </label>
      </div>

      {form.authMethod === 'key' ? (
        <label className="field">
          <span>{t('privateKeyPath')}</span>
          <input
            value={form.privateKeyPath}
            onChange={(e) => setForm((f) => ({ ...f, privateKeyPath: e.target.value }))}
            placeholder="C:\Users\you\.ssh\id_rsa"
            disabled={disabled}
            autoComplete="off"
          />
        </label>
      ) : (
        <label className="field">
          <span>{t('password')}</span>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            disabled={disabled}
            autoComplete="current-password"
          />
        </label>
      )}

      {error ? <p className="form-error">{error}</p> : null}

      <button type="submit" className="btn btn-primary" disabled={disabled}>
        {disabled ? t('connecting') : t('connect')}
      </button>
    </form>
  )
}
