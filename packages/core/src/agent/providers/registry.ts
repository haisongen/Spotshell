import { AnthropicModelProvider } from './anthropicProvider.js';
import { OpenAIModelProvider } from './openaiProvider.js';
import type { ModelProvider, ModelProviderId } from './types.js';

const PROVIDERS: Readonly<Record<ModelProviderId, ModelProvider>> = Object.freeze({
  openai: new OpenAIModelProvider(),
  anthropic: new AnthropicModelProvider(),
});

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = Object.freeze([
  'openai',
  'anthropic',
]);

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return value === 'openai' || value === 'anthropic';
}

export function getModelProvider(id: ModelProviderId): ModelProvider {
  return PROVIDERS[id];
}

export function parseModelProviderId(value: unknown): ModelProviderId {
  if (!isModelProviderId(value)) {
    throw new Error(`Unsupported model provider: ${String(value)}`);
  }
  return value;
}
