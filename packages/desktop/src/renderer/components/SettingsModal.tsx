import { useEffect, useState, type FormEvent } from 'react'
import type { AppSettings, AppTheme, LlmTestResult, ModelProviderErrorKind, ModelProviderId } from '../../shared/ipc-types'
import { lookupKnownModelContextWindow } from '../../shared/knownModelWindows'
import { useTranslation } from '../i18n'
import {
  buildLlmTestRequest,
  buildProviderSettingsPatch,
  createModelProviderDrafts,
  type ModelProviderDrafts,
} from '../modelSettingsForm'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  onSaved?: (settings: AppSettings) => void
}

const EMPTY_DRAFTS: ModelProviderDrafts = {
  openai: { model: 'gpt-4o-mini', baseUrl: '', contextWindowTokens: '128000', apiKey: '', hasApiKey: false },
  anthropic: { model: 'claude-sonnet-4-5', baseUrl: '', contextWindowTokens: '200000', apiKey: '', hasApiKey: false },
}

const PROBE_ERROR_KEYS: Record<ModelProviderErrorKind,
  | 'llmError_authentication'
  | 'llmError_rateLimit'
  | 'llmError_modelNotFound'
  | 'llmError_timeout'
  | 'llmError_network'
  | 'llmError_unsupportedTools'
  | 'llmError_unknown'> = {
  authentication: 'llmError_authentication',
  'rate-limit': 'llmError_rateLimit',
  'model-not-found': 'llmError_modelNotFound',
  timeout: 'llmError_timeout',
  network: 'llmError_network',
  'unsupported-tools': 'llmError_unsupportedTools',
  unknown: 'llmError_unknown',
}

export function SettingsModal({ open, onClose, onSaved }: SettingsModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const [provider, setProvider] = useState<ModelProviderId>('openai')
  const [drafts, setDrafts] = useState<ModelProviderDrafts>(EMPTY_DRAFTS)
  const [recursionLimit, setRecursionLimit] = useState('')
  const [shellIntegration, setShellIntegration] = useState(true)
  const [allowAutoContextCompaction, setAllowAutoContextCompaction] = useState(true)
  const [theme, setTheme] = useState<AppTheme>('dark')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null)
  const draft = drafts[provider]
  const providerName = provider === 'openai' ? t('providerOpenAi') : t('providerAnthropic')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setStatus(null)
    setTestResult(null)
    setBusy(true)
    window.spotshell.getSettings().then((settings) => {
      if (cancelled) return
      setProvider(settings.model.activeProvider)
      setDrafts(createModelProviderDrafts(settings))
      setRecursionLimit(settings.recursionLimit !== undefined ? String(settings.recursionLimit) : '')
      setShellIntegration(settings.shellIntegration)
      setAllowAutoContextCompaction(settings.allowAutoContextCompaction)
      setTheme(settings.theme)
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (!cancelled) setBusy(false)
    })
    return () => { cancelled = true }
  }, [open])

  if (!open) return null

  function updateDraft(patch: Partial<ModelProviderDrafts[ModelProviderId]>): void {
    setDrafts((current) => ({
      ...current,
      [provider]: { ...current[provider], ...patch },
    }))
  }

  function handleModelChange(value: string): void {
    const prefill = lookupKnownModelContextWindow(value)
    updateDraft({
      model: value,
      ...(prefill === undefined ? {} : { contextWindowTokens: String(prefill) }),
    })
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setStatus(null)
    setTestResult(null)
    setBusy(true)
    try {
      let profile
      try {
        profile = buildProviderSettingsPatch(provider, draft)
      } catch {
        throw new Error(t('invalidContextWindow'))
      }
      const limitRaw = recursionLimit.trim()
      const limit = limitRaw ? Number(limitRaw) : undefined
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
        throw new Error(t('invalidRecursionLimit'))
      }
      const next = await window.spotshell.setSettings({
        theme,
        shellIntegration,
        allowAutoContextCompaction,
        recursionLimit: limit === undefined ? undefined : Math.floor(limit),
        model: { activeProvider: provider, provider: profile },
      })
      setDrafts(createModelProviderDrafts(next))
      setStatus(t('settingsSaved'))
      onSaved?.(next)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleClearApiKey(): Promise<void> {
    setError(null)
    setStatus(null)
    setTestResult(null)
    setBusy(true)
    try {
      const next = await window.spotshell.setSettings({
        model: { provider: { provider, apiKey: '' } },
      })
      setDrafts(createModelProviderDrafts(next))
      setStatus(t('providerApiKeyCleared', { provider: providerName }))
      onSaved?.(next)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleTestLlm(): Promise<void> {
    setError(null)
    setStatus(null)
    setTestResult(null)
    setTesting(true)
    try {
      setTestResult(await window.spotshell.testLlm(buildLlmTestRequest(provider, draft)))
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        provider,
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setTesting(false)
    }
  }

  const actionsDisabled = busy || testing
  const canTest = draft.hasApiKey || Boolean(draft.apiKey.trim())
  const probeMessage = testResult?.ok
    ? t('llmProbeSuccess', {
        provider: providerName,
        model: testResult.model ?? draft.model,
        latencyMs: String(testResult.latencyMs ?? 0),
      })
    : testResult?.errorKind
      ? t(PROBE_ERROR_KEYS[testResult.errorKind])
      : testResult?.message

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-header">
          <h2 id="settings-title">{t('settings')}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('close')}</button>
        </header>
        <form className="modal-body" onSubmit={handleSubmit}>
          <fieldset className="settings-appearance" disabled={actionsDisabled}>
            <legend id="appearance-label">{t('appearance')}</legend>
            <div className="theme-segmented" role="radiogroup" aria-labelledby="appearance-label">
              <label><input type="radio" name="theme" value="dark" checked={theme === 'dark'} onChange={() => setTheme('dark')} /><span>{t('themeDark')}</span></label>
              <label><input type="radio" name="theme" value="light" checked={theme === 'light'} onChange={() => setTheme('light')} /><span>{t('themeLight')}</span></label>
            </div>
          </fieldset>

          <label className="field">
            <span>{t('modelProvider')}</span>
            <select value={provider} onChange={(e) => { setProvider(e.target.value as ModelProviderId); setTestResult(null); setStatus(null) }} disabled={actionsDisabled}>
              <option value="openai">{t('providerOpenAi')}</option>
              <option value="anthropic">{t('providerAnthropic')}</option>
            </select>
          </label>

          <label className="field">
            <span>{t('providerApiKey', { provider: providerName })}</span>
            <input type="password" value={draft.apiKey} onChange={(e) => updateDraft({ apiKey: e.target.value })} placeholder={draft.hasApiKey ? t('keepSavedKey') : t('apiKeyPlaceholder')} disabled={actionsDisabled} autoComplete="off" />
            <span className="field-hint">{draft.hasApiKey ? t('encryptedKeyHint') : t('noApiKey')}</span>
          </label>
          {draft.hasApiKey ? <button type="button" className="btn btn-ghost btn-sm" onClick={handleClearApiKey} disabled={actionsDisabled}>{t('clearProviderApiKey', { provider: providerName })}</button> : null}

          <label className="field">
            <span>{t('baseUrl')}</span>
            <input value={draft.baseUrl} onChange={(e) => updateDraft({ baseUrl: e.target.value })} placeholder={provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'} disabled={actionsDisabled} autoComplete="off" />
            <span className="field-hint">{t('providerBaseUrlHint')}</span>
          </label>
          <label className="field"><span>{t('model')}</span><input value={draft.model} onChange={(e) => handleModelChange(e.target.value)} placeholder={provider === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-4-5'} disabled={actionsDisabled} autoComplete="off" /></label>
          <label className="field"><span>{t('contextWindow')}</span><input value={draft.contextWindowTokens} onChange={(e) => updateDraft({ contextWindowTokens: e.target.value })} inputMode="numeric" disabled={actionsDisabled} autoComplete="off" /><span className="field-hint">{t('contextWindowHint')}</span></label>
          <label className="field"><span>{t('recursionLimit')}</span><input value={recursionLimit} onChange={(e) => setRecursionLimit(e.target.value)} placeholder="25" inputMode="numeric" disabled={actionsDisabled} /></label>
          <label className="field field-checkbox"><input type="checkbox" checked={shellIntegration} onChange={(e) => setShellIntegration(e.target.checked)} disabled={actionsDisabled} /><span>{t('shellIntegrationLabel')}</span></label>
          <p className="hint">{t('shellIntegrationHint')}</p>
          <label className="field field-checkbox"><input type="checkbox" checked={allowAutoContextCompaction} onChange={(e) => setAllowAutoContextCompaction(e.target.checked)} disabled={actionsDisabled} /><span>{t('allowAutoContextCompactionLabel')}</span></label>
          <p className="hint">{t('allowAutoContextCompactionHint')}</p>

          <div className="settings-test-row"><button type="button" className="btn btn-secondary" onClick={handleTestLlm} disabled={actionsDisabled || !canTest}>{testing ? t('testing') : t('testConnection')}</button><span className="field-hint">{t('testDraftHint')}</span></div>
          {testResult ? <p className={testResult.ok ? 'form-status form-status-ok' : 'form-error'} role="status">{testResult.ok ? 'OK: ' : ''}{probeMessage}{testResult.statusCode ? ` (HTTP ${testResult.statusCode})` : ''}</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
          {status ? <p className="form-status">{status}</p> : null}
          <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose} disabled={actionsDisabled}>{t('cancel')}</button><button type="submit" className="btn btn-primary" disabled={actionsDisabled}>{busy ? t('saving') : t('save')}</button></div>
        </form>
      </div>
    </div>
  )
}
