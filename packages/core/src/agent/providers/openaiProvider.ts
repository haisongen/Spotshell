import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { normalizeAssistantFailure, normalizeProviderError } from './errorNormalization.js';
import {
  fallbackContextWindow,
  requestOptionsFor,
  resolveBuiltinModel,
  resolveCustomEndpointModel,
} from './piModel.js';
import type { ModelProvider, ModelProviderConfig, ResolvedModel } from './types.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * pi-ai subpaths are loaded on demand. Only the OpenAI provider and its wire
 * protocols are ever named here, so `builtinModels()` and the remaining
 * built-in catalogs — along with the AWS and Google SDKs behind them — stay out
 * of the dependency graph entirely.
 */
const loadBuiltinProvider = async () =>
  (await import('@earendil-works/pi-ai/providers/openai')).openaiProvider();
const loadCompletionsStreams = async () =>
  (await import('@earendil-works/pi-ai/api/openai-completions.lazy')).openAICompletionsApi();

type OpenAIModelFactory = (fields: ConstructorParameters<typeof ChatOpenAI>[0]) => BaseChatModel;

export class OpenAIModelProvider implements ModelProvider {
  readonly id = 'openai' as const;
  readonly defaultModel = 'gpt-4o-mini';

  constructor(
    private readonly factory: OpenAIModelFactory = (fields) => new ChatOpenAI(fields),
  ) {}

  createChatModel(config: ModelProviderConfig): BaseChatModel {
    if (!config.apiKey.trim()) throw new Error('The current model provider has no API key configured.');
    return this.factory({
      apiKey: config.apiKey,
      model: config.model || this.defaultModel,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      configuration: config.baseURL ? { baseURL: config.baseURL } : undefined,
    });
  }

  resolveModel(config: ModelProviderConfig): Promise<ResolvedModel> {
    const requestOptions = requestOptionsFor(config);
    const modelId = config.model || this.defaultModel;
    const baseURL = config.baseURL?.trim();
    if (baseURL) {
      return resolveCustomEndpointModel({
        providerId: this.id,
        providerName: 'OpenAI',
        api: 'openai-completions',
        loadStreams: loadCompletionsStreams,
        baseUrl: baseURL,
        modelId,
        contextWindow: fallbackContextWindow(modelId),
        requestOptions,
      });
    }
    return resolveBuiltinModel({
      providerId: this.id,
      loadProvider: loadBuiltinProvider,
      modelId,
      fallbackApi: 'openai-responses',
      fallbackBaseUrl: OPENAI_BASE_URL,
      fallbackContextWindow: fallbackContextWindow(modelId),
      requestOptions,
    });
  }

  normalizeError = normalizeProviderError;

  normalizeAssistantFailure = normalizeAssistantFailure;
}
