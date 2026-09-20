import { normalizeAssistantFailure, normalizeProviderError } from './errorNormalization.js';
import {
  fallbackContextWindow,
  requestOptionsFor,
  resolveBuiltinModel,
  resolveCustomEndpointModel,
} from './piModel.js';
import type { ModelProvider, ModelProviderConfig, ResolvedModel } from './types.js';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** On-demand pi-ai subpaths; see the note in `openaiProvider.ts`. */
const loadBuiltinProvider = async () =>
  (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider();
const loadMessagesStreams = async () =>
  (await import('@earendil-works/pi-ai/api/anthropic-messages.lazy')).anthropicMessagesApi();

export class AnthropicModelProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly defaultModel = 'claude-sonnet-4-5';

  resolveModel(config: ModelProviderConfig): Promise<ResolvedModel> {
    const requestOptions = requestOptionsFor(config);
    const modelId = config.model || this.defaultModel;
    const baseURL = config.baseURL?.trim();
    if (baseURL) {
      return resolveCustomEndpointModel({
        providerId: this.id,
        providerName: 'Anthropic',
        api: 'anthropic-messages',
        loadStreams: loadMessagesStreams,
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
      fallbackApi: 'anthropic-messages',
      fallbackBaseUrl: ANTHROPIC_BASE_URL,
      fallbackContextWindow: fallbackContextWindow(modelId),
      requestOptions,
    });
  }

  normalizeError = normalizeProviderError;

  normalizeAssistantFailure = normalizeAssistantFailure;
}
