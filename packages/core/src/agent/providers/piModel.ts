import type {
  Api,
  ApiKeyAuth,
  Model,
  MutableModels,
  Provider,
  ProviderStreams,
} from '@earendil-works/pi-ai';
import { resolveContextWindow } from '../modelContext.js';
import type { ModelProviderConfig, ResolvedModel, ResolvedModelRequestOptions } from './types.js';

/**
 * pi-ai is ESM-only and its `exports` map declares the `import` condition only,
 * so a static import would make every module that transitively reaches the
 * `@spotshell/core` barrel unloadable from a CommonJS context — which is what
 * the Electron main-process test runner still is. Loading it through `import()`
 * keeps the barrel importable from both module systems and lets the bundler put
 * pi-ai in its own chunk. The cost is that `resolveModel` is async.
 */
type PiAi = typeof import('@earendil-works/pi-ai');

let piAi: Promise<PiAi> | undefined;

function loadPiAi(): Promise<PiAi> {
  piAi ??= import('@earendil-works/pi-ai');
  return piAi;
}

/**
 * Output-token ceiling baked into synthesized models. pi-ai requires
 * `Model.maxTokens` even when the request supplies its own `maxTokens`
 * (anthropic-messages sends `options.maxTokens ?? model.maxTokens`), and a
 * custom endpoint tells us nothing about the real limit.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Auth for a SpotShell-owned provider instance. SpotShell always passes the
 * configured key explicitly, so this deliberately resolves only the request
 * credential and never reads ambient environment variables — an operator's
 * `OPENAI_API_KEY` must not leak into a request aimed at a custom endpoint.
 */
function settingsApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted();
      if (!credential?.key) return undefined;
      return { auth: { apiKey: credential.key }, source: 'SpotShell settings' };
    },
  };
}

export function requestOptionsFor(config: ModelProviderConfig): ResolvedModelRequestOptions {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('The current model provider has no API key configured.');
  return {
    apiKey,
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
  };
}

function clampMaxOutputTokens(contextWindow: number): number {
  return Math.max(1, Math.min(DEFAULT_MAX_OUTPUT_TOKENS, contextWindow));
}

export interface SynthesizedModelOptions {
  providerId: string;
  api: Api;
  modelId: string;
  baseUrl: string;
  contextWindow: number;
}

/**
 * Builds a `Model` for an endpoint pi-ai has no catalog entry for: a custom
 * `baseURL`, or a model id the built-in catalog does not list. Metadata the
 * catalog would normally supply is filled with conservative values; cost is
 * zeroed because SpotShell does not bill on pi-ai usage numbers.
 */
export function synthesizeModel(options: SynthesizedModelOptions): Model<Api> {
  return {
    id: options.modelId,
    name: options.modelId,
    api: options.api,
    provider: options.providerId,
    baseUrl: options.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow,
    maxTokens: clampMaxOutputTokens(options.contextWindow),
  };
}

export interface CustomEndpointOptions {
  /** Provider id reused from the SpotShell whitelist so settings stay stable. */
  providerId: string;
  providerName: string;
  api: Api;
  /** Lazily loaded stream implementation for `api`. */
  loadStreams: () => Promise<ProviderStreams>;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  requestOptions: ResolvedModelRequestOptions;
}

/** Path 2: the user supplied a `baseURL`, so the endpoint is described by us. */
export async function resolveCustomEndpointModel(
  options: CustomEndpointOptions,
): Promise<ResolvedModel> {
  const [{ createModels, createProvider }, streams] = await Promise.all([
    loadPiAi(),
    options.loadStreams(),
  ]);
  const model = synthesizeModel({
    providerId: options.providerId,
    api: options.api,
    modelId: options.modelId,
    baseUrl: options.baseUrl,
    contextWindow: options.contextWindow,
  });
  const provider: Provider<Api> = createProvider({
    id: options.providerId,
    name: options.providerName,
    baseUrl: options.baseUrl,
    auth: { apiKey: settingsApiKeyAuth(`${options.providerName} API key`) },
    models: [model],
    api: streams,
  });
  const models: MutableModels = createModels();
  models.setProvider(provider);
  return { model, models, requestOptions: options.requestOptions };
}

export interface BuiltinEndpointOptions {
  providerId: string;
  /** Builds a fresh built-in provider; nothing is cached across requests. */
  loadProvider: () => Promise<Provider<Api>>;
  modelId: string;
  /** API and base URL used when the catalog does not list `modelId`. */
  fallbackApi: Api;
  fallbackBaseUrl: string;
  fallbackContextWindow: number;
  requestOptions: ResolvedModelRequestOptions;
}

/** Path 1: no `baseURL`, so pi-ai's built-in provider and catalog are used. */
export async function resolveBuiltinModel(options: BuiltinEndpointOptions): Promise<ResolvedModel> {
  const [{ createModels }, provider] = await Promise.all([loadPiAi(), options.loadProvider()]);
  const models: MutableModels = createModels();
  models.setProvider(provider);
  const known = models.getModel(options.providerId, options.modelId);
  if (known) {
    return {
      model: known,
      models,
      requestOptions: options.requestOptions,
      providerContextWindow: known.contextWindow,
    };
  }
  // The catalog ships a fixed snapshot; a model released after it, or a
  // deployment alias, still has to work through the official endpoint.
  return {
    model: synthesizeModel({
      providerId: options.providerId,
      api: options.fallbackApi,
      modelId: options.modelId,
      baseUrl: options.fallbackBaseUrl,
      contextWindow: options.fallbackContextWindow,
    }),
    models,
    requestOptions: options.requestOptions,
  };
}

/** Context window for a model pi-ai cannot describe. */
export function fallbackContextWindow(modelId: string): number {
  return resolveContextWindow({ model: modelId });
}
