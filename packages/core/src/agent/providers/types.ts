import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type ModelProviderId = 'openai' | 'anthropic';

export interface ModelProviderConfig {
  provider: ModelProviderId;
  apiKey: string;
  model: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ModelProviderErrorKind =
  | 'authentication'
  | 'rate-limit'
  | 'model-not-found'
  | 'timeout'
  | 'network'
  | 'unsupported-tools'
  | 'unknown';

export interface ModelProviderErrorInfo {
  kind: ModelProviderErrorKind;
  message: string;
  statusCode?: number;
}

export interface ModelProvider {
  readonly id: ModelProviderId;
  readonly defaultModel: string;
  createChatModel(config: ModelProviderConfig): BaseChatModel;
  normalizeError(error: unknown): ModelProviderErrorInfo;
}
