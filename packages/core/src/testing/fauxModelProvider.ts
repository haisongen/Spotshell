/**
 * Scripted pi-ai provider for tests.
 *
 * Wraps `fauxProvider()` in a SpotShell `ModelProvider` so a `SpotShellAgent`
 * can be driven end to end without credentials, a catalog lookup, or network
 * access, while still exercising the real pi agent loop, the real streaming
 * event protocol, and the real tool executor.
 *
 * pi-ai is ESM-only with an `import`-only export condition, so it is loaded
 * through `import()`; that is also why this helper is async.
 */

import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type {
  ModelProvider,
  ModelProviderConfig,
  ModelProviderId,
  ResolvedModel,
} from '../agent/providers/types.js';

export type PiAi = typeof import('@earendil-works/pi-ai');

export function loadPiAi(): Promise<PiAi> {
  return import('@earendil-works/pi-ai');
}

/** Shallow snapshot of one request as the provider saw it. */
export interface SeenRequest {
  systemPrompt: string;
  messages: Context['messages'];
  toolNames: string[];
}

export interface FauxModelProvider {
  readonly provider: ModelProvider;
  /** One entry per provider request, in call order. */
  readonly requests: SeenRequest[];
  /** Concatenated text of every message in a recorded request. */
  requestText(index: number): string;
  setResponses(responses: readonly AssistantMessage[]): void;
  appendResponses(responses: readonly AssistantMessage[]): void;
  /** Number of scripted responses not yet consumed. */
  pendingResponses(): number;
}

export interface FauxModelProviderOptions {
  id?: ModelProviderId;
  modelId?: string;
  contextWindow?: number;
  responses?: readonly AssistantMessage[];
  /** Simulated streaming rate; the default emits the whole text in one delta. */
  tokensPerSecond?: number;
}

export async function createFauxModelProvider(
  options: FauxModelProviderOptions = {},
): Promise<FauxModelProvider> {
  const pi = await loadPiAi();
  const id = options.id ?? 'openai';
  const modelId = options.modelId ?? 'faux-model';
  const faux = pi.fauxProvider({
    provider: id,
    models: [{ id: modelId, contextWindow: options.contextWindow ?? 1_000_000, maxTokens: 8_192 }],
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });
  const models = pi.createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const requests: SeenRequest[] = [];

  const record = (responses: readonly AssistantMessage[]) =>
    responses.map((message) => (context: Context) => {
      requests.push({
        systemPrompt: context.systemPrompt ?? '',
        messages: [...context.messages],
        toolNames: (context.tools ?? []).map((tool) => tool.name),
      });
      return message;
    });

  faux.setResponses(record(options.responses ?? []));

  const provider: ModelProvider = {
    id,
    defaultModel: modelId,
    resolveModel(config: ModelProviderConfig): Promise<ResolvedModel> {
      // Mirrors the real providers: a missing key throws synchronously.
      const apiKey = config.apiKey.trim();
      if (!apiKey) throw new Error('The current model provider has no API key configured.');
      return Promise.resolve({ model, models, requestOptions: { apiKey } });
    },
    normalizeError: (error) => ({
      kind: 'unknown',
      message: error instanceof Error ? error.message : String(error),
    }),
    normalizeAssistantFailure: (message) => ({
      kind: 'unknown',
      message: message.errorMessage ?? 'provider failed',
    }),
  };

  return {
    provider,
    requests,
    requestText: (index) => (requests[index]?.messages ?? [])
      .map((message) => JSON.stringify(message.content))
      .join('\n'),
    setResponses: (responses) => faux.setResponses(record(responses)),
    appendResponses: (responses) => faux.appendResponses(record(responses)),
    pendingResponses: () => faux.getPendingResponseCount(),
  };
}
