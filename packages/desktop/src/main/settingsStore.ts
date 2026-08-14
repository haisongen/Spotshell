import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, safeStorage } from 'electron'
import type { AgentConfig } from '@spotshell/core'
import type {
  AppSettings,
  ModelProviderId,
  SettingsPatch,
} from '../shared/ipc-types'
import { settingsFilePath, settingsSecretsPath } from './paths'
import { allowPlaintextSecrets } from './secretsPolicy'
import {
  DEFAULT_PROVIDER_MODELS,
  decodeSecretsEnvelope,
  encodeSecretsEnvelope,
  hasAnyProviderApiKey,
  normalizeStoredModelSettings,
  setProviderApiKey,
  toPublicProviderSettings,
  type ProviderApiKeys,
  type StoredModelSettings,
} from './modelSettings'

interface SettingsFileShape {
  language?: 'en' | 'zh-CN'
  theme?: 'dark' | 'light'
  shellIntegration?: boolean
  model?: StoredModelSettings
  recursionLimit?: number
  allowAutoContextCompaction?: boolean
  // Read-only legacy fields retained until a model setting is successfully written.
  openAiBaseUrl?: string
  openAiModel?: string
  contextWindowTokens?: number
  apiKeyPlaintextDevFallback?: string
}

const DEFAULT_RECURSION_LIMIT = 25

export class SettingsStore {
  getPublicSettings(): AppSettings {
    const data = this.readFile()
    const model = normalizeStoredModelSettings(data)
    const apiKeys = this.readApiKeys(data)
    return {
      language: data.language ?? 'en',
      theme: data.theme ?? 'dark',
      shellIntegration: data.shellIntegration ?? true,
      model: {
        activeProvider: model.activeProvider,
        providers: toPublicProviderSettings(model, apiKeys),
      },
      recursionLimit: data.recursionLimit,
      allowAutoContextCompaction: data.allowAutoContextCompaction !== false,
    }
  }

  getAgentConfig(): AgentConfig | null {
    const data = this.readFile()
    const settings = normalizeStoredModelSettings(data)
    const provider = settings.activeProvider
    const profile = settings.providers[provider]
    const apiKey = this.readApiKeys(data)[provider]
    if (!apiKey) return null
    return {
      provider,
      apiKey,
      model: profile.model || DEFAULT_PROVIDER_MODELS[provider],
      baseURL: profile.baseUrl,
      recursionLimit: data.recursionLimit ?? DEFAULT_RECURSION_LIMIT,
      contextWindowTokens: toPublicProviderSettings(settings, { [provider]: apiKey })[provider]
        .contextWindowTokens,
      allowAutoContextCompaction: data.allowAutoContextCompaction !== false,
      language: data.language ?? 'en',
    }
  }

  getProviderApiKey(provider: ModelProviderId): string | undefined {
    return this.readApiKeys(this.readFile())[provider]
  }

  isShellIntegrationEnabled(): boolean {
    return this.readFile().shellIntegration ?? true
  }

  update(patch: SettingsPatch): AppSettings {
    const data = this.readFile()
    this.applyCommonPatch(data, patch)

    if (!patch.model) {
      this.writeFile(data)
      return this.getPublicSettings()
    }

    const model = normalizeStoredModelSettings(data)
    let apiKeys = this.readApiKeys(data)
    const hadSecretsFile = fs.existsSync(settingsSecretsPath())
    if (patch.model.activeProvider) model.activeProvider = patch.model.activeProvider

    const profilePatch = patch.model.provider
    if (profilePatch) {
      const profile = model.providers[profilePatch.provider]
      if (profilePatch.model !== undefined) {
        profile.model = profilePatch.model.trim() || undefined
      }
      if (profilePatch.baseUrl !== undefined) {
        profile.baseUrl = profilePatch.baseUrl.trim() || undefined
      }
      if (profilePatch.contextWindowTokens !== undefined) {
        profile.contextWindowTokens = profilePatch.contextWindowTokens ?? undefined
      }
      if (profilePatch.apiKey !== undefined) {
        apiKeys = setProviderApiKey(apiKeys, profilePatch.provider, profilePatch.apiKey)
      }
    }

    // When keys exist, write the complete new envelope first. If the settings
    // write fails, legacy settings can still read it without losing either key.
    if (hasAnyProviderApiKey(apiKeys)) this.writeApiKeys(apiKeys)
    const migrated: SettingsFileShape = {
      language: data.language,
      theme: data.theme,
      shellIntegration: data.shellIntegration,
      model,
      recursionLimit: data.recursionLimit,
      allowAutoContextCompaction: data.allowAutoContextCompaction,
    }
    this.writeFile(migrated)
    if (profilePatch?.apiKey !== undefined && !hasAnyProviderApiKey(apiKeys)) {
      if (hadSecretsFile && !safeStorage.isEncryptionAvailable()
        && !allowPlaintextSecrets(app.isPackaged)) {
        throw new Error('Secure storage is unavailable; refusing to clear an unreadable API key.')
      }
      this.removeSecretsFile()
    }
    return this.getPublicSettings()
  }

  private applyCommonPatch(data: SettingsFileShape, patch: SettingsPatch): void {
    data.theme ??= 'dark'
    if (patch.language === 'en' || patch.language === 'zh-CN') data.language = patch.language
    if (patch.theme === 'dark' || patch.theme === 'light') data.theme = patch.theme
    if (typeof patch.shellIntegration === 'boolean') data.shellIntegration = patch.shellIntegration
    if (typeof patch.allowAutoContextCompaction === 'boolean') {
      data.allowAutoContextCompaction = patch.allowAutoContextCompaction
    }
    if (patch.recursionLimit !== undefined) {
      data.recursionLimit = Number.isFinite(patch.recursionLimit) && patch.recursionLimit > 0
        ? Math.floor(patch.recursionLimit)
        : undefined
    }
  }

  private readFile(): SettingsFileShape {
    const filePath = settingsFilePath()
    if (!fs.existsSync(filePath)) return {}
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SettingsFileShape
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  }

  private writeFile(data: SettingsFileShape): void {
    const filePath = settingsFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.atomicWrite(filePath, JSON.stringify(data, null, 2))
  }

  private readApiKeys(data: SettingsFileShape): ProviderApiKeys {
    const secretsPath = settingsSecretsPath()
    if (fs.existsSync(secretsPath)) {
      try {
        const buf = fs.readFileSync(secretsPath)
        if (buf.length > 0 && safeStorage.isEncryptionAvailable()) {
          try {
            return decodeSecretsEnvelope(safeStorage.decryptString(buf))
          } catch {
            // Fall through to the development-only plaintext format.
          }
        }
        if (buf.length > 0 && allowPlaintextSecrets(app.isPackaged)) {
          const plaintext = buf.toString('utf8')
          if (!plaintext.includes('\0')) return decodeSecretsEnvelope(plaintext)
        }
      } catch {
        return {}
      }
    }
    if (!allowPlaintextSecrets(app.isPackaged)) return {}
    return decodeSecretsEnvelope(data.apiKeyPlaintextDevFallback)
  }

  private writeApiKeys(apiKeys: ProviderApiKeys): void {
    const secretsPath = settingsSecretsPath()
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true })
    const envelope = encodeSecretsEnvelope(apiKeys)
    if (safeStorage.isEncryptionAvailable()) {
      this.atomicWrite(secretsPath, safeStorage.encryptString(envelope))
      return
    }
    if (!allowPlaintextSecrets(app.isPackaged)) {
      throw new Error(
        'Secure storage (safeStorage) is unavailable; refusing to save API keys in a packaged build.'
      )
    }
    this.atomicWrite(secretsPath, envelope)
  }

  private removeSecretsFile(): void {
    const secretsPath = settingsSecretsPath()
    if (!fs.existsSync(secretsPath)) return
    try {
      fs.unlinkSync(secretsPath)
    } catch {
      // The empty envelope remains safe and represents no configured key.
    }
  }

  private atomicWrite(filePath: string, data: string | Buffer): void {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporaryPath, data)
      fs.renameSync(temporaryPath, filePath)
    } finally {
      if (fs.existsSync(temporaryPath)) {
        try { fs.unlinkSync(temporaryPath) } catch { /* ignore cleanup failure */ }
      }
    }
  }
}

export const settingsStore = new SettingsStore()
