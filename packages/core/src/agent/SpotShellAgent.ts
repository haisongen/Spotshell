import type { Api, AssistantMessage, Message as PiMessage, Model } from '@earendil-works/pi-ai';
import type { Agent as PiAgent, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AgentConfig,
  SSHExecutor,
  AgentContext,
  ChatStreamOptions,
  AgentLanguage,
  AgentRuntime,
  AgentStreamEvent,
  AgentToolDefinition,
} from './types.js';
import { createSSHTools, type SSHToolExtras } from './tools.js';
import { sanitizeToolCallHistory, trimHistoryToBudget } from './history.js';
import {
  messageText,
  userMessage,
  type AgentMessage,
} from './message.js';
import {
  assistantText,
  capToolResultContent,
  fromPiMessages,
  sanitizePiMessages,
  toPiMessages,
  toPiTools,
  trimPiMessagesToBudget,
  type PiAssistantOrigin,
} from './piAdapter.js';
import { buildSystemPrompt, buildContextMessage } from './prompt.js';
import { resolveContextWindow } from './modelContext.js';
import {
  assembleModelContext,
  type ContextAssemblyResult,
  type GuidanceRule,
} from '../context/ContextAssembler.js';
import {
  buildCompactionSummaryRecord,
  formatCompactionSummariesForContext,
  planContextCompaction,
  type CompactionSummaryRecord,
} from '../context/ContextCompaction.js';
import type { KnowledgeProvenanceRecord } from '../knowledge/provenance.js';
import { getModelProvider } from './providers/registry.js';
import type {
  ModelProvider,
  ModelProviderConfig,
  ModelProviderErrorInfo,
  ModelProviderId,
  ResolvedModel,
} from './providers/types.js';

/** Conservative fixed reserve for bound tool schemas (names alone undercount). */
const TOOLS_SCHEMA_RESERVE_CHARS = 3_000;

/** Single tool result may not exceed this many characters in the transcript. */
const TOOL_RESULT_MAX_CHARS = 2_000;

/** Output ceiling for the synthesized model used when a stream function is injected. */
const INJECTED_MAX_OUTPUT_TOKENS = 8_192;

/**
 * `@earendil-works/pi-agent-core` is ESM-only and declares an `import`-only
 * export condition, exactly like pi-ai. Loading it through `import()` keeps the
 * `@spotshell/core` barrel importable from CommonJS (the Electron main-process
 * test runner) and keeps pi out of the main-process startup path.
 */
type PiAgentCore = typeof import('@earendil-works/pi-agent-core');

let piAgentCore: Promise<PiAgentCore> | undefined;

function loadPiAgentCore(): Promise<PiAgentCore> {
  piAgentCore ??= import('@earendil-works/pi-agent-core');
  return piAgentCore;
}

export type ContextCompactionSummarizer = (input: {
  messages: AgentMessage[];
  modelName: string;
  language: AgentLanguage;
}) => Promise<string>;

export interface SpotShellAgentDependencies {
  /**
   * Replaces the pi-ai stream function and skips provider model resolution
   * entirely. Tests inject a `fauxProvider()`-backed function here so no
   * credential, catalog, or network access is needed.
   */
  streamFn?: StreamFn;
  providerResolver?: (id: ModelProviderId) => ModelProvider;
  /** Injectable one-shot history summarizer (tests / alternate providers). */
  summarizer?: ContextCompactionSummarizer;
}

export class AgentCancelledError extends Error {
  constructor() {
    super('Agent generation cancelled');
    this.name = 'AgentCancelledError';
  }
}

/** Everything the turn loop needs to talk to a provider. */
interface RuntimeModel {
  model: Model<Api>;
  streamFn: StreamFn;
  /** Context window the pi-ai catalog reported, when it knew the model. */
  providerContextWindow?: number;
}

function isAssistantMessage(message: PiMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

export class SpotShellAgent implements AgentRuntime {
  private executor: SSHExecutor;
  private tools: AgentToolDefinition[];
  private piTools: AgentTool<any>[];
  private agent: PiAgent | null = null;
  private recursionLimit?: number;
  private conversationHistory: AgentMessage[] = [];
  /** Independent one-shot summaries; never re-fed into a later summary. */
  private compactionSummaries: CompactionSummaryRecord[] = [];
  private readonly language: AgentLanguage;
  private readonly systemPrompt: string;
  private readonly knowledgeAccess?: SSHToolExtras['knowledge'];
  private contextWindowTokens: number;
  /** True once `updateContextWindow()` spoke; provider metadata must not override it. */
  private contextWindowExplicit = false;
  private allowAutoContextCompaction: boolean;
  private modelName: string;
  private modelConfig: AgentConfig;
  private provider: ModelProvider;
  private readonly providerResolver: (id: ModelProviderId) => ModelProvider;
  private readonly injectedStreamFn?: StreamFn;
  private readonly summarizer: ContextCompactionSummarizer;
  private lastContextAssembly: ContextAssemblyResult | null = null;
  private guidanceRules: GuidanceRule[] = [];
  private catalogText?: string;
  private environmentText?: string;
  private referenceText?: string;
  /** In-flight or settled provider resolution for the current model selection. */
  private pendingResolution: Promise<ResolvedModel> | null = null;
  private runtimeModel: RuntimeModel | null = null;
  /** Outbound history budget for the turn currently running. */
  private turnHistoryBudget = Number.POSITIVE_INFINITY;
  /** LLM turns taken inside the run currently in flight; reset before every prompt. */
  private turnCount = 0;

  constructor(
    config: AgentConfig,
    executor: SSHExecutor,
    extras?: SSHToolExtras,
    dependencies: SpotShellAgentDependencies = {}
  ) {
    this.executor = executor;
    this.language = config.language ?? 'zh-CN';
    this.systemPrompt = buildSystemPrompt(this.language, {
      noteTool: Boolean(extras?.proposeHostNote),
      knowledgeProposalTool: Boolean(extras?.proposeKnowledgeChange),
      knowledgeTools: Boolean(extras?.knowledge),
    });
    this.providerResolver = dependencies.providerResolver ?? getModelProvider;
    this.injectedStreamFn = dependencies.streamFn;
    this.modelConfig = config;
    this.provider = this.providerResolver(config.provider ?? 'openai');
    this.modelName = config.model?.trim() || this.provider.defaultModel;
    this.contextWindowTokens = resolveContextWindow({
      contextWindowTokens: config.contextWindowTokens,
      model: this.modelName,
    });
    this.allowAutoContextCompaction = config.allowAutoContextCompaction !== false;
    // Eager, like the old `createChatModel()` call: an unusable selection
    // (missing API key, unknown provider) still fails at construction time.
    this.pendingResolution = this.startModelResolution(config, this.provider, this.modelName);

    this.summarizer = dependencies.summarizer
      ?? ((input) => this.defaultCompactionSummarizer(input));

    this.tools = createSSHTools(executor, extras);
    this.piTools = toPiTools(this.tools);
    this.knowledgeAccess = extras?.knowledge;
    this.recursionLimit = config.recursionLimit;
  }

  /** Optional knowledge/reference content for the ContextAssembler meter and budgets. */
  setKnowledgeContext(options: {
    guidance?: readonly GuidanceRule[];
    catalog?: string;
    environment?: string;
    reference?: string;
  }): void {
    this.guidanceRules = options.guidance ? [...options.guidance] : [];
    this.catalogText = options.catalog;
    this.environmentText = options.environment;
    this.referenceText = options.reference;
  }

  getLastContextAssembly(): ContextAssemblyResult | null {
    return this.lastContextAssembly;
  }

  /** Apply a new context window after model settings change. */
  updateContextWindow(contextWindowTokens: number): void {
    this.contextWindowTokens = Math.max(1, Math.floor(contextWindowTokens));
    this.contextWindowExplicit = true;
  }

  /** Apply the model preference for automatic old-context compression. */
  updateAllowAutoContextCompaction(allow: boolean): void {
    this.allowAutoContextCompaction = allow;
  }

  /**
   * Atomically replace the provider model while preserving all conversation state.
   *
   * Resolution itself is asynchronous (pi-ai is loaded on demand), so the new
   * model only becomes usable on the next turn. The resolution is *started*
   * here rather than deferred, which keeps the previous contract that an
   * unusable selection — missing API key, unsupported provider id — is
   * rejected synchronously and leaves every field below untouched.
   */
  updateModel(config: AgentConfig): void {
    const provider = this.providerResolver(config.provider ?? 'openai');
    const modelName = config.model?.trim() || provider.defaultModel;
    const contextWindowTokens = resolveContextWindow({
      contextWindowTokens: config.contextWindowTokens,
      model: modelName,
    });
    const pendingResolution = this.startModelResolution(config, provider, modelName);

    this.modelConfig = config;
    this.provider = provider;
    this.modelName = modelName;
    this.contextWindowTokens = contextWindowTokens;
    this.contextWindowExplicit = false;
    this.allowAutoContextCompaction = config.allowAutoContextCompaction !== false;
    this.recursionLimit = config.recursionLimit;
    this.pendingResolution = pendingResolution;
    this.runtimeModel = null;
  }

  getCompactionSummaries(): CompactionSummaryRecord[] {
    return this.compactionSummaries.map((summary) => ({ ...summary }));
  }

  /** Test helper: seed independent summaries without going through a chat turn. */
  replaceCompactionSummariesForTest(summaries: readonly CompactionSummaryRecord[]): void {
    this.compactionSummaries = summaries.map((summary) => ({ ...summary }));
  }

  /**
   * Recompute usage with a new model window without sending a chat request.
   * Used when the user changes model/context-window settings.
   */
  recomputeContextUsage(context: AgentContext, currentRequest = ''): ContextAssemblyResult {
    return this.assembleForTurn(currentRequest, context);
  }

  /**
   * Kick off provider model resolution. Returns `null` when a stream function
   * was injected, because then no provider is involved at all.
   */
  private startModelResolution(
    config: AgentConfig,
    provider: ModelProvider,
    modelName: string,
  ): Promise<ResolvedModel> | null {
    if (this.injectedStreamFn) return null;
    const pending = provider.resolveModel(this.toProviderConfig(config, provider, modelName));
    // The rejection is re-awaited by the next turn; swallow it here so an agent
    // that is never used cannot crash the process with an unhandled rejection.
    void pending.catch(() => undefined);
    return pending;
  }

  private async ensureRuntimeModel(): Promise<RuntimeModel> {
    if (this.runtimeModel) return this.runtimeModel;

    if (this.injectedStreamFn) {
      this.runtimeModel = { model: this.synthesizeInjectedModel(), streamFn: this.injectedStreamFn };
      return this.runtimeModel;
    }

    this.pendingResolution ??= this.startModelResolution(
      this.modelConfig,
      this.provider,
      this.modelName,
    );
    const resolved = await this.pendingResolution!;
    if (!this.contextWindowExplicit) {
      this.contextWindowTokens = resolveContextWindow({
        contextWindowTokens: this.modelConfig.contextWindowTokens,
        model: this.modelName,
        providerContextWindow: resolved.providerContextWindow,
      });
    }
    this.runtimeModel = {
      model: resolved.model,
      // pi-ai carries credentials and sampling knobs on the request, so they are
      // spread in here once instead of being baked into the model description.
      streamFn: (model, context, options) =>
        resolved.models.streamSimple(model, context, { ...options, ...resolved.requestOptions }),
      ...(resolved.providerContextWindow === undefined
        ? {}
        : { providerContextWindow: resolved.providerContextWindow }),
    };
    return this.runtimeModel;
  }

  /** Stand-in model description for an injected stream function. */
  private synthesizeInjectedModel(): Model<Api> {
    return {
      id: this.modelName,
      name: this.modelName,
      api: 'openai-completions',
      provider: this.provider.id,
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: this.contextWindowTokens,
      maxTokens: Math.max(1, Math.min(INJECTED_MAX_OUTPUT_TOKENS, this.contextWindowTokens)),
    } as Model<Api>;
  }

  private async ensureAgent(): Promise<PiAgent> {
    if (this.agent) return this.agent;
    const runtime = await this.ensureRuntimeModel();
    const { Agent } = await loadPiAgentCore();
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model: runtime.model,
        thinkingLevel: 'off',
        tools: this.piTools,
        messages: [],
      },
      // Always read the *current* runtime model; `updateModel()` swaps it out
      // underneath without rebuilding the agent.
      streamFn: (model, context, options) =>
        (this.runtimeModel ?? runtime).streamFn(model, context, options),
      // Drop tool batches the provider would reject, exactly as the LangGraph
      // agent node did before every `invoke()`.
      convertToLlm: (messages) => sanitizePiMessages(messages as PiMessage[]),
      // Outbound-only soft trim; the local transcript is never reduced by it.
      transformContext: async (messages) =>
        trimPiMessagesToBudget(messages as PiMessage[], this.turnHistoryBudget),
      afterToolCall: async ({ result }) => {
        const capped = capToolResultContent(result.content, TOOL_RESULT_MAX_CHARS);
        return capped ? { content: capped } : undefined;
      },
      // pi has no `recursionLimit`; count turns and stop gracefully instead.
      shouldStopAfterTurn: async () => {
        this.turnCount += 1;
        return this.recursionLimit !== undefined && this.turnCount >= this.recursionLimit;
      },
    });
    return this.agent;
  }

  async chatStream(
    userInput: string,
    context: AgentContext,
    opts: ChatStreamOptions = {}
  ): Promise<string> {
    this.conversationHistory = sanitizeToolCallHistory(this.conversationHistory);

    let agent: PiAgent;
    let runtime: RuntimeModel;
    try {
      // Resolve first: the provider catalog may refine the context window the
      // assembler below meters against.
      runtime = await this.ensureRuntimeModel();
      agent = await this.ensureAgent();
    } catch (error) {
      if (opts.signal?.aborted) throw new AgentCancelledError();
      return this.describeFailure(this.provider.normalizeError(error));
    }

    // Optionally compact older eligible history before the live turn.
    await this.maybeCompactHistory(userInput, context, opts.onEvent);

    const assembly = this.assembleForTurn(userInput, context);
    opts.onEvent?.({ type: 'context_usage', usage: assembly });

    const contextMessage = this.buildBudgetedContextMessage(context, assembly);
    // Never exceed the assembler-assigned chat remainder for the outbound request.
    const historyBudget = Math.max(0, assembly.chatBudgetTokens);
    const fullHistory = this.conversationHistory;
    const history = trimHistoryToBudget(fullHistory, historyBudget);
    const turnUserMessage = userMessage(userInput);
    const origin = this.originOf(runtime.model);

    // Single crossing into the pi runtime; everything above is framework neutral.
    // pi 0.85.1 has no system role in the transcript, so the base prompt and the
    // per-turn context block travel together in `systemPrompt`, replaced wholesale
    // each turn instead of accumulating stale terminal snapshots.
    agent.state.systemPrompt = `${this.systemPrompt}\n\n${contextMessage}`;
    agent.state.model = runtime.model;
    agent.state.thinkingLevel = 'off';
    agent.state.tools = this.piTools;
    agent.state.messages = toPiMessages(history, origin);
    this.turnHistoryBudget = historyBudget;
    this.turnCount = 0;

    const promptMessage = toPiMessages([turnUserMessage], origin)[0]!;

    let sawTextDelta = false;
    let finalMessages: PiMessage[] = [];
    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case 'message_start':
          if ((event.message as PiMessage).role === 'assistant') sawTextDelta = false;
          break;
        case 'message_update':
          if (event.assistantMessageEvent.type === 'text_delta') {
            const delta = event.assistantMessageEvent.delta;
            if (delta) {
              sawTextDelta = true;
              opts.onEvent?.({ type: 'token', text: delta });
            }
          }
          break;
        case 'message_end': {
          // Fallback for providers that only deliver the full text at the end.
          const message = event.message as PiMessage;
          if (isAssistantMessage(message) && !sawTextDelta) {
            const text = assistantText(message);
            if (text) opts.onEvent?.({ type: 'token', text });
          }
          break;
        }
        case 'agent_end':
          finalMessages = event.messages as PiMessage[];
          break;
      }
    });

    const abortAgent = () => agent.abort();
    opts.signal?.addEventListener('abort', abortAgent, { once: true });
    try {
      if (opts.signal?.aborted) throw new AgentCancelledError();
      await agent.prompt(promptMessage);
    } catch (error) {
      if (error instanceof AgentCancelledError) throw error;
      if (opts.signal?.aborted) throw new AgentCancelledError();
      return this.describeFailure(this.provider.normalizeError(error));
    } finally {
      unsubscribe();
      opts.signal?.removeEventListener('abort', abortAgent);
    }

    // Decide cancellation *before* any history write-back so a half-finished
    // assistant message can never contaminate `conversationHistory`.
    const aborted = opts.signal?.aborted === true
      || finalMessages.some((m) => isAssistantMessage(m) && m.stopReason === 'aborted');
    if (aborted) throw new AgentCancelledError();

    const failed = finalMessages.find(
      (m): m is AssistantMessage => isAssistantMessage(m) && m.stopReason === 'error',
    );
    if (failed) {
      // Same as the LangGraph path: a failed request is reported as an ordinary
      // assistant reply, and nothing is written back to the history.
      return this.describeFailure(this.provider.normalizeAssistantFailure(failed));
    }

    // Difference by identity against the prompt we injected. pi returns only the
    // messages produced by this run, so no baseline length arithmetic is involved.
    const produced = finalMessages.filter((message) => message !== promptMessage);
    const newMessages = fromPiMessages(produced);
    // Persist the full active Agent history. Intentional reduction is only via
    // one-shot compaction (or clearHistory / new context). Soft-trim above is
    // outbound-only so we never silently drop unsummarized messages.
    this.conversationHistory = sanitizeToolCallHistory([
      ...fullHistory,
      turnUserMessage,
      ...newMessages,
    ]);

    const lastAssistant = [...produced].reverse().find(isAssistantMessage);
    const responseText = lastAssistant ? assistantText(lastAssistant) : '';
    const provenance = this.collectProvenance();
    opts.onEvent?.({
      type: 'final',
      text: responseText,
      ...(provenance.length > 0 ? { provenance } : {}),
    });
    return responseText;
  }

  /** Localized, credential-free rendering of a provider failure. */
  private describeFailure(info: ModelProviderErrorInfo): string {
    return this.language === 'en'
      ? `AI processing error: ${info.message}`
      : `AI 处理错误: ${info.message}`;
  }

  private originOf(model: Model<Api>): PiAssistantOrigin {
    return { api: model.api, provider: model.provider, model: model.id };
  }

  private async maybeCompactHistory(
    userInput: string,
    context: AgentContext,
    onEvent?: (event: AgentStreamEvent) => void,
  ): Promise<void> {
    const probe = this.assembleForTurn(userInput, context);
    const plan = planContextCompaction({
      allowAutoCompaction: this.allowAutoContextCompaction,
      usedInputTokens: probe.usedInputTokens,
      availableInputBudget: probe.availableInputBudget,
      chatBudgetTokens: probe.chatBudgetTokens,
      history: this.conversationHistory,
      existingSummaries: this.compactionSummaries,
    });

    if (plan.action === 'none') return;

    if (plan.action === 'hint_over_limit') {
      onEvent?.({ type: 'context_over_limit', reason: plan.reason });
      return;
    }

    try {
      const text = await this.summarizer({
        messages: plan.toCompact,
        modelName: this.modelName,
        language: this.language,
      });
      if (!text.trim()) {
        onEvent?.({
          type: 'context_compaction_failed',
          error: this.language === 'en'
            ? 'Compaction produced an empty summary; original history kept.'
            : '压缩摘要为空，已保留原始 Agent 历史。',
        });
        return;
      }
      const record = buildCompactionSummaryRecord({
        text,
        coveredMessages: plan.toCompact,
        model: this.modelName,
      });
      if (record.estimatedTokens > plan.remainingSummaryBudget) {
        onEvent?.({ type: 'context_over_limit', reason: 'summary_budget_exhausted' });
        return;
      }
      // Apply only after a non-empty summary that fits the shared summary budget.
      this.conversationHistory = [...plan.retain];
      this.compactionSummaries = [...this.compactionSummaries, record];
      onEvent?.({ type: 'context_compaction', summary: { ...record } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onEvent?.({ type: 'context_compaction_failed', error: message });
      // Keep original conversationHistory unchanged.
    }
  }

  private assembleForTurn(userInput: string, context: AgentContext): ContextAssemblyResult {
    const chatText = this.conversationHistory.map(messageText).join('\n');
    const toolEstimate = [
      this.tools.map((tool) => tool.name).join(','),
      'x'.repeat(TOOLS_SCHEMA_RESERVE_CHARS),
    ].join('\n');
    const terminalBundle = [
      context.currentDirectory ? `cwd:${context.currentDirectory}` : '',
      context.lastCommand ? `cmd:${context.lastCommand}` : '',
      context.lastExitCode !== undefined ? `exit:${context.lastExitCode}` : '',
      context.lastError ? `err:${context.lastError}` : '',
      context.terminalHistory,
    ].filter(Boolean).join('\n');
    const compactionSummary = formatCompactionSummariesForContext(
      this.compactionSummaries,
      this.language,
    );
    const assembly = assembleModelContext({
      contextWindowTokens: this.contextWindowTokens,
      system: this.systemPrompt,
      tools: toolEstimate,
      currentRequest: userInput,
      hostNotes: context.hostNotes,
      userQuotes: context.userQuotes,
      terminal: terminalBundle || undefined,
      chat: chatText || undefined,
      compactionSummary,
      environment: this.environmentText,
      guidance: this.guidanceRules,
      catalog: this.catalogText,
      reference: this.referenceText,
    });
    this.lastContextAssembly = assembly;
    return assembly;
  }

  private buildBudgetedContextMessage(
    context: AgentContext,
    assembly: ContextAssemblyResult,
  ): string {
    const assembled = assembly.assembled;
    const budgeted: AgentContext = {
      ...context,
      hostNotes: assembled.hostNotes,
      terminalHistory: assembled.terminal ?? '',
    };
    const base = buildContextMessage(budgeted, this.language);
    const extras: string[] = [];
    if (assembled.environment?.trim()) {
      extras.push(
        this.language === 'en'
          ? `[Environment facts]\n${assembled.environment.trim()}`
          : `[环境事实]\n${assembled.environment.trim()}`,
      );
    }
    if (assembled.guidance?.trim()) {
      extras.push(
        this.language === 'en'
          ? `[Active guidance]\n${assembled.guidance.trim()}`
          : `[已激活指导]\n${assembled.guidance.trim()}`,
      );
    }
    if (assembly.omittedGuidance.length > 0) {
      const omitted = assembly.omittedGuidance
        .map((rule) => `- ${rule.moduleName ?? rule.id}: ${rule.id}`)
        .join('\n');
      extras.push(
        this.language === 'en'
          ? `[Omitted guidance this turn]\n${omitted}`
          : `[本轮未加载指导]\n${omitted}`,
      );
    }
    if (assembly.conflicts.length > 0) {
      const conflicts = assembly.conflicts.map((conflict) => (
        this.language === 'en'
          ? `Conflict (${conflict.left.sourceLayer}):\nA (${conflict.left.moduleName ?? conflict.left.id}): ${conflict.left.text}\nB (${conflict.right.moduleName ?? conflict.right.id}): ${conflict.right.text}`
          : `冲突（${conflict.left.sourceLayer}）:\nA（${conflict.left.moduleName ?? conflict.left.id}）: ${conflict.left.text}\nB（${conflict.right.moduleName ?? conflict.right.id}）: ${conflict.right.text}`
      )).join('\n\n');
      extras.push(conflicts);
    }
    if (assembled.catalog?.trim()) {
      extras.push(
        this.language === 'en'
          ? `[Knowledge catalog]\n${assembled.catalog.trim()}`
          : `[知识目录]\n${assembled.catalog.trim()}`,
      );
    }
    if (assembled.reference?.trim()) {
      extras.push(
        this.language === 'en'
          ? `[Reference knowledge]\n${assembled.reference.trim()}`
          : `[参考知识]\n${assembled.reference.trim()}`,
      );
    }
    if (assembled.userQuotes?.trim()) {
      extras.push(
        this.language === 'en'
          ? `[User-quoted prior context]\n${assembled.userQuotes.trim()}`
          : `[用户引用的旧上下文]\n${assembled.userQuotes.trim()}`,
      );
    }
    if (assembled.compactionSummary?.trim()) {
      extras.push(assembled.compactionSummary.trim());
    }
    return extras.length > 0 ? `${base}\n\n${extras.join('\n\n')}` : base;
  }

  async chat(userInput: string, context: AgentContext): Promise<string> {
    return this.chatStream(userInput, context);
  }

  getHistory(): AgentMessage[] {
    return [...this.conversationHistory];
  }

  setHistory(messages: readonly AgentMessage[]): void {
    this.conversationHistory = sanitizeToolCallHistory(messages);
  }

  clearHistory(): void {
    this.conversationHistory = [];
    this.compactionSummaries = [];
  }

  private collectProvenance(): KnowledgeProvenanceRecord[] {
    const harness = this.knowledgeAccess?.getHarness();
    return harness ? harness.takeProvenance() : [];
  }

  /**
   * One-shot summarization through the same stream function the turn loop uses.
   * Deliberately tool-free and history-free: the transcript is the only input.
   */
  private async defaultCompactionSummarizer(input: {
    messages: AgentMessage[];
    modelName: string;
    language: AgentLanguage;
  }): Promise<string> {
    const runtime = await this.ensureRuntimeModel();
    const transcript = input.messages.map((message) => {
      const role = message.role === 'toolResult' ? 'tool' : message.role;
      return `${role}: ${messageText(message)}`;
    }).join('\n\n');

    const instruction = input.language === 'en'
      ? [
          'Summarize the following earlier conversation and completed tool outputs for continuity.',
          'Keep facts, open questions, decisions, and unresolved tasks.',
          'Do not invent knowledge, host facts, or command success.',
          'Return only the summary text.',
        ].join(' ')
      : [
          '请将以下较早对话与已完成的工具输出压缩为连续摘要。',
          '保留事实、未决问题、决策与未完成任务。',
          '不要编造知识、主机事实或命令成功结论。',
          '只返回摘要正文。',
        ].join('');

    const stream = await runtime.streamFn(runtime.model, {
      systemPrompt: instruction,
      messages: [{ role: 'user', content: transcript, timestamp: Date.now() }],
    });
    const message = await stream.result();
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      throw new Error(this.provider.normalizeAssistantFailure(message).message);
    }
    return assistantText(message);
  }

  private toProviderConfig(
    config: AgentConfig,
    provider: ModelProvider,
    model: string,
  ): ModelProviderConfig {
    const envKey = provider.id === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    return {
      provider: provider.id,
      apiKey: config.apiKey ?? process.env[envKey] ?? '',
      model,
      baseURL: config.baseURL,
      temperature: config.temperature ?? 0.1,
    };
  }
}
