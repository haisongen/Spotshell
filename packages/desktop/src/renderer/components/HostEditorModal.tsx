import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  HostConnectionTestDraft,
  HostConnectionTestResult,
  EnvironmentSummary,
  SavedHostInput,
  SavedHostProfile,
} from '../../shared/ipc-types'
import {
  convertHostForm,
  convertHostTestDraft,
  hostToEditorForm,
  type HostEditorFormValues,
  type HostFormValidationError,
} from '../hostManagement'
import { useTranslation } from '../i18n'

export type HostEditorMode = 'create' | 'edit'

interface HostEditorModalProps {
  open: boolean
  mode: HostEditorMode
  host?: SavedHostProfile | null
  busy?: boolean
  testing?: boolean
  folderId?: string
  environments: EnvironmentSummary[]
  onClose: () => void
  onSubmit: (input: SavedHostInput) => Promise<void> | void
  onTest?: (draft: HostConnectionTestDraft) => Promise<HostConnectionTestResult>
}

export function HostEditorModal({
  open,
  mode,
  host,
  busy = false,
  testing = false,
  folderId,
  environments,
  onClose,
  onSubmit,
  onTest,
}: HostEditorModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const [form, setForm] = useState<HostEditorFormValues>(() => hostToEditorForm(host))
  const [clearSavedPassword, setClearSavedPassword] = useState(false)
  const [error, setError] = useState<HostFormValidationError | string | null>(null)
  const [testResult, setTestResult] = useState<HostConnectionTestResult | null>(null)
  const initialFocusRef = useRef<HTMLInputElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const testVersionRef = useRef(0)

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
    setForm(hostToEditorForm(mode === 'edit' ? host : null))
    setClearSavedPassword(false)
    setError(null)
    setTestResult(null)
    testVersionRef.current += 1
    requestAnimationFrame(() => initialFocusRef.current?.focus())
  }, [open, mode, host?.id])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy && !testing) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose, open, testing])

  if (!open) return null

  const titleId = 'host-editor-title'
  const errorId = 'host-editor-error'
  const hasSavedPassword = mode === 'edit' && Boolean(host?.hasPassword)
  const initialAuthMethod = host?.authMethod ?? (host?.hasPassword ? 'password' : 'key')
  const changingAwayFromStoredPassword =
    hasSavedPassword && initialAuthMethod === 'password' && form.authMethod !== 'password'

  function update<K extends keyof HostEditorFormValues>(
    key: K,
    value: HostEditorFormValues[K]
  ): void {
    setForm((current) => ({ ...current, [key]: value }))
    setError(null)
    if (key === 'host' || key === 'port' || key === 'username' || key === 'authMethod' ||
      key === 'privateKeyPath' || key === 'password') {
      testVersionRef.current += 1
      setTestResult(null)
    }
  }

  async function handleTest(): Promise<void> {
    if (!host || !onTest || busy || testing) return
    const result = convertHostTestDraft(form, { hasSavedPassword, clearSavedPassword })
    if (!result.ok) {
      setError(result.error)
      setTestResult(null)
      return
    }
    setError(null)
    setTestResult(null)
    const testVersion = ++testVersionRef.current
    try {
      const nextResult = await onTest(result.draft)
      if (testVersionRef.current === testVersion) setTestResult(nextResult)
    } catch (testError: unknown) {
      if (testVersionRef.current === testVersion) {
        setTestResult({
          ok: false,
          message: testError instanceof Error ? testError.message : String(testError),
          latencyMs: 0,
        })
      }
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    const result = convertHostForm(form, {
      hasSavedPassword,
      initialAuthMethod,
      clearSavedPassword,
    })
    if (!result.ok) {
      setError(result.error)
      return
    }

    setError(null)
    try {
      await onSubmit(mode === 'create' ? { ...result.input, folderId } : result.input)
      onClose()
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    }
  }

  const errorText =
    error === 'requiredHostFields' || error === 'invalidPort' || error === 'confirmPasswordClear' ||
      error === 'privateKeyRequired' || error === 'passwordAuthRequired'
      ? t(error)
      : error

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && !testing) onClose()
      }}
    >
      <section
        className="modal host-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={errorText ? errorId : undefined}
      >
        <header className="modal-header">
          <h2 id={titleId}>{t(mode === 'edit' ? 'editHostTitle' : 'addHostTitle')}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={busy || testing}
          >
            {t('close')}
          </button>
        </header>

        <form className="modal-body host-editor-form" onSubmit={(event) => void handleSubmit(event)}>
          <label className="field">
            <span>{t('name')}</span>
            <input
              ref={initialFocusRef}
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
              placeholder="prod-jump"
              disabled={busy}
              autoComplete="off"
            />
          </label>

          <label className="field">
            <span>{t('host')}</span>
            <input
              value={form.host}
              onChange={(event) => update('host', event.target.value)}
              placeholder="10.0.0.12"
              disabled={busy}
              autoComplete="off"
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>{t('port')}</span>
              <input
                value={form.port}
                onChange={(event) => update('port', event.target.value)}
                inputMode="numeric"
                disabled={busy}
              />
            </label>
            <label className="field">
              <span>{t('username')}</span>
              <input
                value={form.username}
                onChange={(event) => update('username', event.target.value)}
                placeholder="root"
                disabled={busy}
                autoComplete="off"
              />
            </label>
          </div>

          <label className="field">
            <span>{t('authMethod')}</span>
            <select
              value={form.authMethod}
              onChange={(event) =>
                update(
                  'authMethod',
                  event.target.value as HostEditorFormValues['authMethod']
                )
              }
              disabled={busy}
            >
              <option value="key">{t('privateKey')}</option>
              <option value="password">{t('password')}</option>
              <option value="agent">{t('sshAgent')}</option>
            </select>
          </label>

          <div className="host-editor-auth-fields">
            {form.authMethod === 'password' ? (
              <label className="field">
                <span>{t('password')}</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(event) => {
                    update('password', event.target.value)
                    if (event.target.value) setClearSavedPassword(false)
                  }}
                  placeholder={hasSavedPassword ? t('replacePasswordPlaceholder') : undefined}
                  disabled={busy}
                  autoComplete="new-password"
                />
                {hasSavedPassword && !clearSavedPassword ? (
                  <small className="field-hint">{t('storedPasswordHint')}</small>
                ) : null}
              </label>
            ) : form.authMethod === 'key' ? (
              <label className="field">
                <span>{t('privateKeyPath')}</span>
                <input
                  value={form.privateKeyPath}
                  onChange={(event) => update('privateKeyPath', event.target.value)}
                  placeholder="C:\\Users\\you\\.ssh\\id_rsa"
                  disabled={busy}
                  autoComplete="off"
                />
              </label>
            ) : (
              <div className="host-editor-agent-spacer" aria-hidden="true" />
            )}
          </div>

          {hasSavedPassword && form.authMethod === 'password' ? (
            <div className="host-editor-password-action">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setClearSavedPassword((value) => !value)
                  update('password', '')
                  setTestResult(null)
                }}
                disabled={busy}
              >
                {clearSavedPassword ? t('passwordClearPending') : t('clearSavedPassword')}
              </button>
            </div>
          ) : null}

          {changingAwayFromStoredPassword ? (
            <label className="host-editor-password-warning">
              <input
                type="checkbox"
                checked={clearSavedPassword}
                onChange={(event) => {
                  setClearSavedPassword(event.target.checked)
                  setError(null)
                  setTestResult(null)
                  testVersionRef.current += 1
                }}
                disabled={busy}
              />
              <span>{t('authChangeClearsPassword')}</span>
            </label>
          ) : null}

          <label className="field">
            <span>{t('automaticEnvironment')}</span>
            <select
              value={form.environmentId ?? ''}
              onChange={(event) => update('environmentId', event.target.value || undefined)}
              disabled={busy}
            >
              <option value="">{t('noAutomaticEnvironment')}</option>
              {form.environmentId && !environments.some((entry) => entry.id === form.environmentId) ? (
                <option value={form.environmentId}>{t('missingEnvironmentBinding')}</option>
              ) : null}
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>{environment.name}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t('hostNotes')}</span>
            <textarea
              value={form.notes}
              onChange={(event) => update('notes', event.target.value)}
              placeholder={t('hostNotesPlaceholder')}
              rows={3}
              maxLength={4000}
              disabled={busy}
            />
          </label>

          {errorText ? (
            <p id={errorId} className="form-error" role="alert">
              {errorText}
            </p>
          ) : null}

          {testResult ? (
            <p
              className={`host-test-result ${testResult.ok ? 'host-test-result-success' : 'host-test-result-error'}`}
              role={testResult.ok ? 'status' : 'alert'}
            >
              {testResult.ok
                ? t('testDraftConnectionSuccess', { latencyMs: testResult.latencyMs })
                : t('testDraftConnectionFailed', { message: testResult.message })}
            </p>
          ) : null}

          <div className="host-editor-actions">
            {mode === 'edit' ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleTest()}
                disabled={busy || testing}
              >
                {testing ? t('testingHostConnection') : t('testHostConnection')}
              </button>
            ) : <span />}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy || testing}>
                {t('cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || testing}>
                {busy ? t('saving') : t(mode === 'edit' ? 'saveChanges' : 'addHost')}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  )
}
