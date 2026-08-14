import type {
  AppSettings,
  LlmTestRequest,
  ModelProviderId,
  ModelProviderSettingsPatch,
} from '../shared/ipc-types'

export interface ModelProviderDraft {
  model: string
  baseUrl: string
  contextWindowTokens: string
  apiKey: string
  hasApiKey: boolean
}

export type ModelProviderDrafts = Record<ModelProviderId, ModelProviderDraft>

export function createModelProviderDrafts(settings: AppSettings): ModelProviderDrafts {
  return {
    openai: toDraft(settings, 'openai'),
    anthropic: toDraft(settings, 'anthropic'),
  }
}

export function buildProviderSettingsPatch(
  provider: ModelProviderId,
  draft: ModelProviderDraft,
): ModelProviderSettingsPatch {
  const contextWindowTokens = Number(draft.contextWindowTokens)
  if (!Number.isInteger(contextWindowTokens)
    || contextWindowTokens < 4_096
    || contextWindowTokens > 2_000_000) {
    throw new Error('invalid-context-window')
  }
  return {
    provider,
    model: draft.model,
    baseUrl: draft.baseUrl,
    contextWindowTokens,
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
  }
}

export function buildLlmTestRequest(
  provider: ModelProviderId,
  draft: ModelProviderDraft,
): LlmTestRequest {
  return {
    provider,
    apiKey: draft.apiKey.trim() || undefined,
    model: draft.model.trim() || undefined,
    baseUrl: draft.baseUrl.trim() || undefined,
  }
}

function toDraft(settings: AppSettings, provider: ModelProviderId): ModelProviderDraft {
  const profile = settings.model.providers[provider]
  return {
    model: profile.model,
    baseUrl: profile.baseUrl ?? '',
    contextWindowTokens: String(profile.contextWindowTokens),
    apiKey: '',
    hasApiKey: profile.hasApiKey,
  }
}
