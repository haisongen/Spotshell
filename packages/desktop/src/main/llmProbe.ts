import { getModelProvider } from '@spotshell/core'
import type { ModelProvider, ModelProviderId } from '@spotshell/core'
import type { LlmTestRequest, LlmTestResult } from '../shared/ipc-types'
import { DEFAULT_PROVIDER_MODELS } from './modelSettings'
import { settingsStore } from './settingsStore'

const TIMEOUT_MS = 20_000

export interface LlmProbeDependencies {
  getProvider?: (id: ModelProviderId) => ModelProvider
  getSavedApiKey?: (id: ModelProviderId) => string | undefined
  now?: () => number
  timeoutMs?: number
}

export async function testLlmConnection(
  draft: LlmTestRequest,
  dependencies: LlmProbeDependencies = {},
): Promise<LlmTestResult> {
  const getProvider = dependencies.getProvider ?? getModelProvider
  const getSavedApiKey = dependencies.getSavedApiKey
    ?? ((provider) => settingsStore.getProviderApiKey(provider))
  const now = dependencies.now ?? Date.now
  const timeoutMs = dependencies.timeoutMs ?? TIMEOUT_MS
  const provider = getProvider(draft.provider)
  const apiKey = draft.apiKey?.trim() || getSavedApiKey(draft.provider)?.trim() || ''
  const model = draft.model?.trim() || DEFAULT_PROVIDER_MODELS[draft.provider]
  if (!apiKey) {
    return {
      ok: false,
      provider: draft.provider,
      model,
      message: 'The current model provider has no API key configured.',
      errorKind: 'authentication',
    }
  }

  const started = now()
  const abort = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const chatModel = provider.createChatModel({
      provider: draft.provider,
      apiKey,
      model,
      baseURL: draft.baseUrl?.trim() || undefined,
      temperature: 0,
      maxTokens: 8,
    })
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        abort.abort()
        reject(new Error('Model provider probe timed out'))
      }, timeoutMs)
    })
    await Promise.race([chatModel.invoke('ping', { signal: abort.signal }), timeout])
    const latencyMs = now() - started
    return {
      ok: true,
      provider: draft.provider,
      message: 'The model provider responded successfully.',
      model,
      latencyMs,
    }
  } catch (error) {
    const latencyMs = now() - started
    const normalized = timedOut
      ? { kind: 'timeout' as const, message: 'The model provider request timed out.' }
      : provider.normalizeError(error)
    return {
      ok: false,
      provider: draft.provider,
      message: normalized.message,
      model,
      latencyMs,
      statusCode: normalized.statusCode,
      errorKind: normalized.kind,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
