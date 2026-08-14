import { resolveContextWindow } from '@spotshell/core'
import type {
  ModelProviderId,
  PublicModelProviderSettings,
} from '../shared/ipc-types'

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = ['openai', 'anthropic']
export const DEFAULT_PROVIDER_MODELS: Readonly<Record<ModelProviderId, string>> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
}

export interface StoredModelProfile {
  model?: string
  baseUrl?: string
  contextWindowTokens?: number
}

export interface StoredModelSettings {
  activeProvider: ModelProviderId
  providers: Record<ModelProviderId, StoredModelProfile>
}

export interface ProviderApiKeys {
  openai?: string
  anthropic?: string
}

export function normalizeStoredModelSettings(input: unknown): StoredModelSettings {
  const raw = isRecord(input) ? input : {}
  const nested = isRecord(raw.model) ? raw.model : undefined
  const nestedProviders = nested && isRecord(nested.providers) ? nested.providers : {}
  const hasNestedModel = Boolean(nested)
  const activeProvider = hasNestedModel && isProviderId(nested?.activeProvider)
    ? nested.activeProvider
    : 'openai'

  return {
    activeProvider,
    providers: {
      openai: normalizeProfile(
        nestedProviders.openai,
        hasNestedModel ? undefined : raw.openAiModel,
        hasNestedModel ? undefined : raw.openAiBaseUrl,
        hasNestedModel ? undefined : raw.contextWindowTokens,
      ),
      anthropic: normalizeProfile(nestedProviders.anthropic),
    },
  }
}

export function toPublicProviderSettings(
  stored: StoredModelSettings,
  apiKeys: ProviderApiKeys,
): Record<ModelProviderId, PublicModelProviderSettings> {
  return {
    openai: toPublicProfile('openai', stored.providers.openai, apiKeys),
    anthropic: toPublicProfile('anthropic', stored.providers.anthropic, apiKeys),
  }
}

export function decodeSecretsEnvelope(plaintext: string | undefined): ProviderApiKeys {
  const value = plaintext?.trim()
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (isRecord(parsed) && ('version' in parsed || 'apiKeys' in parsed)) {
      if (parsed.version !== 1 || !isRecord(parsed.apiKeys)) return {}
      return normalizeApiKeys(parsed.apiKeys)
    }
  } catch {
    // A legacy key is an arbitrary non-empty plaintext string.
  }
  return { openai: value }
}

export function encodeSecretsEnvelope(apiKeys: ProviderApiKeys): string {
  return JSON.stringify({ version: 1, apiKeys: normalizeApiKeys(apiKeys) })
}

export function setProviderApiKey(
  apiKeys: ProviderApiKeys,
  provider: ModelProviderId,
  value: string,
): ProviderApiKeys {
  const next = { ...normalizeApiKeys(apiKeys) }
  const trimmed = value.trim()
  if (trimmed) next[provider] = trimmed
  else delete next[provider]
  return next
}

export function hasAnyProviderApiKey(apiKeys: ProviderApiKeys): boolean {
  return MODEL_PROVIDER_IDS.some((provider) => Boolean(apiKeys[provider]))
}

function normalizeProfile(
  value: unknown,
  legacyModel?: unknown,
  legacyBaseUrl?: unknown,
  legacyContextWindow?: unknown,
): StoredModelProfile {
  const raw = isRecord(value) ? value : {}
  return {
    model: cleanString(raw.model ?? legacyModel),
    baseUrl: cleanString(raw.baseUrl ?? legacyBaseUrl),
    contextWindowTokens: normalizeContextWindow(raw.contextWindowTokens ?? legacyContextWindow),
  }
}

function normalizeContextWindow(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 4_096
    && value <= 2_000_000
    ? value
    : undefined
}

function toPublicProfile(
  provider: ModelProviderId,
  profile: StoredModelProfile,
  apiKeys: ProviderApiKeys,
): PublicModelProviderSettings {
  const model = profile.model || DEFAULT_PROVIDER_MODELS[provider]
  return {
    model,
    baseUrl: profile.baseUrl,
    contextWindowTokens: resolveContextWindow({
      contextWindowTokens: profile.contextWindowTokens,
      model,
    }),
    hasApiKey: Boolean(apiKeys[provider]),
  }
}

function normalizeApiKeys(value: unknown): ProviderApiKeys {
  if (!isRecord(value)) return {}
  const openai = cleanString(value.openai)
  const anthropic = cleanString(value.anthropic)
  return {
    ...(openai ? { openai } : {}),
    ...(anthropic ? { anthropic } : {}),
  }
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() || undefined
}

function isProviderId(value: unknown): value is ModelProviderId {
  return value === 'openai' || value === 'anthropic'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
