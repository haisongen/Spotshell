import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, AIMessage, SystemMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
import type { CompiledStateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type {
  AgentConfig,
  SSHExecutor,
  AgentContext,
  ChatStreamOptions,
  AgentLanguage,
  AgentRuntime,
  AgentStreamEvent,
} from './types.js';
import { createSSHTools, type SSHToolExtras } from './tools.js';
import { capToolMessage, sanitizeToolCallHistory, trimHistoryToBudget } from './history.js';
import { buildSystemPrompt, buildContextMessage } from './prompt.js';
import { resolveContextWindow } from './modelContext.js';
import {
  assembleModelContext,
  type ContextAssemblyResult,
  type GuidanceRule,
} from '../context/ContextAssembler.js';
import {
  buildCompactionSummaryRecord,
  ensureMessageIds,
  formatCompactionSummariesForContext,
  planContextCompaction,
  type CompactionSummaryRecord,
} from '../context/ContextCompaction.js';
import type { KnowledgeProvenanceRecord } from '../knowledge/provenance.js';
import { getModelProvider } from './providers/registry.js';
import type { ModelProvider, ModelProviderConfig, ModelProviderId } from './providers/types.js';

/** Conservative fixed reserve for bound tool schemas (names alone undercount). */
const TOOLS_SCHEMA_RESERVE_CHARS = 3_000;

export type ContextCompactionSummarizer = (input: {
  messages: BaseMessage[];
  modelName: string;
  language: AgentLanguage;
}) => Promise<string>;

export interface SpotShellAgentDependencies {
  model?: BaseChatModel;
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

export class SpotShellAgent implements AgentRuntime {
  private model: BaseChatModel;
  private executor: SSHExecutor;
  private tools: ReturnType<typeof createSSHTools>;
  private graph: CompiledStateGraph<any, any, any> | null = null;
  private recursionLimit?: number;
  private conversationHistory: BaseMessage[] = [];
  /** Independent one-shot summaries; never re-fed into a later summary. */
  private compactionSummaries: CompactionSummaryRecord[] = [];
  private readonly language: AgentLanguage;
  private readonly systemPrompt: string;
  private readonly knowledgeAccess?: SSHToolExtras['knowledge'];
  private contextWindowTokens: number;
  private allowAutoContextCompaction: boolean;
  private modelName: string;
  private provider: ModelProvider;
  private readonly providerResolver: (id: ModelProviderId) => ModelProvider;
  private readonly summarizer: ContextCompactionSummarizer;
  private lastContextAssembly: ContextAssemblyResult | null = null;
  private guidanceRules: GuidanceRule[] = [];
  private catalogText?: string;
  private environmentText?: string;
  private referenceText?: string;

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
    this.provider = this.providerResolver(config.provider ?? 'openai');
    this.modelName = config.model?.trim() || this.provider.defaultModel;
    this.contextWindowTokens = resolveContextWindow({
      contextWindowTokens: config.contextWindowTokens,
      model: this.modelName,
    });
    this.allowAutoContextCompaction = config.allowAutoContextCompaction !== false;

    this.model = dependencies.model ?? this.provider.createChatModel(
      this.toProviderConfig(config, this.provider, this.modelName),
    );
    this.summarizer = dependencies.summarizer
      ?? ((input) => defaultCompactionSummarizer(this.model, input));

    this.tools = createSSHTools(executor, extras);
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
  }

  /** Apply the model preference for automatic old-context compression. */
  updateAllowAutoContextCompaction(allow: boolean): void {
    this.allowAutoContextCompaction = allow;
  }

  /** Atomically replace the provider model while preserving all conversation state. */
  updateModel(config: AgentConfig): void {
    const provider = this.providerResolver(config.provider ?? 'openai');
    const modelName = config.model?.trim() || provider.defaultModel;
    const contextWindowTokens = resolveContextWindow({
      contextWindowTokens: config.contextWindowTokens,
      model: modelName,
    });
    const nextModel = provider.createChatModel(this.toProviderConfig(config, provider, modelName));

    this.model = nextModel;
    this.provider = provider;
    this.modelName = modelName;
    this.contextWindowTokens = contextWindowTokens;
    this.allowAutoContextCompaction = config.allowAutoContextCompaction !== false;
    this.recursionLimit = config.recursionLimit;
    this.graph = null;
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

  private buildGraph(): CompiledStateGraph<any, any, any> {
    if (!this.model.bindTools) {
      throw new Error('Agent model must support tool binding');
    }
    const modelWithTools = this.model.bindTools(this.tools);

    // 定义 agent 节点
    const callModel = async (state: typeof MessagesAnnotation.State) => {
      const response = await modelWithTools.invoke(sanitizeToolCallHistory(state.messages));
      return { messages: [response] };
    };

    // 定义路由函数
    const shouldContinue = (state: typeof MessagesAnnotation.State) => {
      const lastMessage = state.messages[state.messages.length - 1];
      if (lastMessage && 'tool_calls' in lastMessage) {
        const aiMessage = lastMessage as AIMessage;
        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
          return 'tools';
        }
      }
      return END;
    };

    // 构建图
    const toolNode = new ToolNode(this.tools);

    const workflow = new StateGraph(MessagesAnnotation as any) as StateGraph<any, any, any>;

    workflow
      .addNode('agent', callModel)
      .addNode('tools', toolNode)
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', shouldContinue)
      .addEdge('tools', 'agent');

    return workflow.compile() as CompiledStateGraph<any, any, any>;
  }

  async chatStream(
    userInput: string,
    context: AgentContext,
    opts: ChatStreamOptions = {}
  ): Promise<string> {
    const graph = this.graph ?? (this.graph = this.buildGraph());
    this.conversationHistory = ensureMessageIds(
      sanitizeToolCallHistory(this.conversationHistory),
    );

    // Optionally compact older eligible history before the live turn.
    await this.maybeCompactHistory(userInput, context, opts.onEvent);

    const assembly = this.assembleForTurn(userInput, context);
    opts.onEvent?.({ type: 'context_usage', usage: assembly });

    const contextMessage = this.buildBudgetedContextMessage(context, assembly);
    // Never exceed the assembler-assigned chat remainder for the outbound request.
    const historyBudget = Math.max(0, assembly.chatBudgetTokens);
    const fullHistory = this.conversationHistory;
    const history = trimHistoryToBudget(fullHistory, historyBudget);
    const baseline: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      new SystemMessage(contextMessage),
      ...history,
      new HumanMessage(userInput),
    ];

    try {
      const stream = await graph.stream(
        { messages: baseline },
        {
          streamMode: ['values', 'messages'],
          signal: opts.signal,
          ...(this.recursionLimit ? { recursionLimit: this.recursionLimit } : {}),
        }
      );

      let lastValues: { messages: BaseMessage[] } | null = null;
      for await (const [mode, chunk] of stream as AsyncIterable<[string, any]>) {
        if (mode === 'messages') {
          const [msgChunk, meta] = chunk as [any, { langgraph_node?: string }];
          if (meta?.langgraph_node === 'agent'
            && typeof msgChunk?.content === 'string'
            && msgChunk.content) {
            opts.onEvent?.({ type: 'token', text: msgChunk.content });
          }
        } else if (mode === 'values') {
          lastValues = chunk as { messages: BaseMessage[] };
        }
      }

      const finalMessages = lastValues?.messages ?? baseline;
      const lastMessage = finalMessages[finalMessages.length - 1];
      let responseText = '';
      if (lastMessage && AIMessage.isInstance(lastMessage)) {
        responseText = typeof lastMessage.content === 'string'
          ? lastMessage.content
          : JSON.stringify(lastMessage.content);
      }

      const newMessages = finalMessages.slice(baseline.length).map((message) =>
        ToolMessage.isInstance(message) ? capToolMessage(message, 2000) : message
      );
      // Persist the full active Agent history. Intentional reduction is only via
      // one-shot compaction (or clearHistory / new context). Soft-trim above is
      // outbound-only so we never silently drop unsummarized messages.
      this.conversationHistory = ensureMessageIds(sanitizeToolCallHistory([
        ...fullHistory,
        new HumanMessage(userInput),
        ...newMessages,
      ]));
      const provenance = this.collectProvenance();
      opts.onEvent?.({
        type: 'final',
        text: responseText,
        ...(provenance.length > 0 ? { provenance } : {}),
      });
      return responseText;
    } catch (error) {
      if (opts.signal?.aborted) throw new AgentCancelledError();
      const normalized = this.provider.normalizeError(error);
      return this.language === 'en'
        ? `AI processing error: ${normalized.message}`
        : `AI 处理错误: ${normalized.message}`;
    }
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
      this.conversationHistory = ensureMessageIds(plan.retain);
      this.compactionSummaries = [...this.compactionSummaries, record];
      onEvent?.({ type: 'context_compaction', summary: { ...record } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onEvent?.({ type: 'context_compaction_failed', error: message });
      // Keep original conversationHistory unchanged.
    }
  }

  private assembleForTurn(userInput: string, context: AgentContext): ContextAssemblyResult {
    const chatText = this.conversationHistory
      .map((message) => {
        const content = typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content);
        return content;
      })
      .join('\n');
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

  getHistory(): BaseMessage[] {
    return [...this.conversationHistory];
  }

  setHistory(messages: BaseMessage[]): void {
    this.conversationHistory = ensureMessageIds(sanitizeToolCallHistory(messages));
  }

  clearHistory(): void {
    this.conversationHistory = [];
    this.compactionSummaries = [];
  }

  private collectProvenance(): KnowledgeProvenanceRecord[] {
    const harness = this.knowledgeAccess?.getHarness();
    return harness ? harness.takeProvenance() : [];
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

async function defaultCompactionSummarizer(
  model: BaseChatModel,
  input: {
    messages: BaseMessage[];
    modelName: string;
    language: AgentLanguage;
  },
): Promise<string> {
  const transcript = input.messages.map((message) => {
    const role = HumanMessage.isInstance(message)
      ? 'user'
      : AIMessage.isInstance(message)
        ? 'assistant'
        : ToolMessage.isInstance(message)
          ? 'tool'
          : 'other';
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    return `${role}: ${content}`;
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

  const response = await model.invoke([
    new SystemMessage(instruction),
    new HumanMessage(transcript),
  ]);
  return typeof response.content === 'string'
    ? response.content
    : JSON.stringify(response.content);
}
