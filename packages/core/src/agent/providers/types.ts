import type { Api, AssistantMessage, Model, Models } from '@earendil-works/pi-ai';
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

/**
 * Per-request options derived from `ModelProviderConfig`. pi-ai carries the
 * credential and the sampling knobs on the request rather than on the model, so
 * the provider translates them once and callers spread them into
 * `Models.stream()` / `Models.complete()`. An explicit `apiKey` takes priority
 * over every ambient source inside pi-ai, which keeps a stray `OPENAI_API_KEY`
 * in the environment from silently answering for the configured account.
 */
export interface ResolvedModelRequestOptions {
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
}

/** A pi-ai model plus the collection that owns its provider, auth, and stream functions. */
export interface ResolvedModel {
  /** The pi-ai model description handed to `Models.stream()` / `Models.complete()`. */
  model: Model<Api>;
  /** The collection the model belongs to; the caller streams through it. */
  models: Models;
  /** Spread into the stream/complete options of every request for this model. */
  requestOptions: ResolvedModelRequestOptions;
  /**
   * Context window reported by the pi-ai catalog, when the model came from a
   * built-in catalog entry. Undefined for synthesized models (custom base URLs
   * and model ids pi-ai does not know), where the caller falls back to
   * `modelContext.ts`.
   */
  providerContextWindow?: number;
}

export interface ModelProvider {
  readonly id: ModelProviderId;
  readonly defaultModel: string;
  /**
   * Transitional LangChain entry point. `SpotShellAgent` still runs on
   * LangGraph and needs a `BaseChatModel`; it is removed once the agent
   * executor moves to pi.
   */
  createChatModel(config: ModelProviderConfig): BaseChatModel;
  /**
   * pi-ai entry point. Async because pi-ai is ESM-only with `import`-only
   * export conditions and is therefore loaded through `import()`; see
   * `piModel.ts`. An invalid config (missing API key) still rejects/throws
   * before any module is loaded.
   */
  resolveModel(config: ModelProviderConfig): Promise<ResolvedModel>;
  /** Normalizes a thrown value (LangChain / direct SDK paths). */
  normalizeError(error: unknown): ModelProviderErrorInfo;
  /** Normalizes a failed pi-ai `AssistantMessage` (pi-ai does not throw). */
  normalizeAssistantFailure(message: AssistantMessage): ModelProviderErrorInfo;
}
