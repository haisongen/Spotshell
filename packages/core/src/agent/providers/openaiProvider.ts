import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { normalizeProviderError } from './errorNormalization.js';
import type { ModelProvider, ModelProviderConfig } from './types.js';

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

  normalizeError = normalizeProviderError;
}
