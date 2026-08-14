import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { normalizeProviderError } from './errorNormalization.js';
import type { ModelProvider, ModelProviderConfig } from './types.js';

type AnthropicModelFactory = (fields: ConstructorParameters<typeof ChatAnthropic>[0]) => BaseChatModel;

export class AnthropicModelProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly defaultModel = 'claude-sonnet-4-5';

  constructor(
    private readonly factory: AnthropicModelFactory = (fields) => new ChatAnthropic(fields),
  ) {}

  createChatModel(config: ModelProviderConfig): BaseChatModel {
    if (!config.apiKey.trim()) throw new Error('The current model provider has no API key configured.');
    return this.factory({
      apiKey: config.apiKey,
      model: config.model || this.defaultModel,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      clientOptions: config.baseURL ? { baseURL: config.baseURL } : undefined,
    });
  }

  normalizeError = normalizeProviderError;
}
