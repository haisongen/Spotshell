import type { BaseMessage } from '@langchain/core/messages';
import type { CommandResult } from '../ssh/types.js';
import type { KnowledgeProvenanceRecord } from '../knowledge/provenance.js';
import type { ContextAssemblyResult } from '../context/ContextAssembler.js';
import type {
  CompactionOverLimitReason,
  CompactionSummaryRecord,
} from '../context/ContextCompaction.js';
import type { ModelProviderId } from './providers/types.js';

export type AgentLanguage = 'en' | 'zh-CN';

export interface AgentConfig {
  /** Defaults to OpenAI for backwards compatibility. */
  provider?: ModelProviderId;
  apiKey?: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  recursionLimit?: number;
  /**
   * Model context-window size in tokens. Known models may prefill;
   * custom models must supply a positive integer in the validated range.
   */
  contextWindowTokens?: number;
  /**
   * When true (default), older chat/tool output may be summarized once near the
   * context limit. When false, only an over-limit hint is emitted.
   */
  allowAutoContextCompaction?: boolean;
  /** System Prompt 与上下文消息的语言；缺省 zh-CN（保持 CLI 行为不变） */
  language?: AgentLanguage;
}

export interface SSHExecutor {
  execute: (command: string) => Promise<CommandResult>;
  write: (data: string) => Promise<boolean>;
}

export interface AgentContext {
  terminalHistory: string;
  lastCommand?: string;
  lastError?: string;
  currentDirectory?: string;
  /** Shell Integration 标记提供的上一条命令退出码 */
  lastExitCode?: number;
  /** Host Profile 的环境备注（用户手写），随每次 chat 注入 */
  hostNotes?: string;
  /**
   * Explicit user quotes of older context fragments for this turn.
   * Content is already snapshotted and secret-scanned by the caller.
   */
  userQuotes?: string;
}

export type RiskLevel = 'readonly' | 'write' | 'destructive';

/** Per-session policy. Destructive commands always require confirmation. */
export type ExecPolicy = 'readonly' | 'ask' | 'auto';

/** Core stream events do not carry a desktop session identifier. */
export type AgentStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'context_usage'; usage: ContextAssemblyResult }
  | { type: 'final'; text: string; provenance?: KnowledgeProvenanceRecord[] }
  | { type: 'context_compaction'; summary: CompactionSummaryRecord }
  | { type: 'context_compaction_failed'; error: string }
  | { type: 'context_over_limit'; reason: CompactionOverLimitReason };

export interface ChatStreamOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
}

export type AgentHistory = BaseMessage[];

export interface AgentRuntime {
  chatStream(
    userInput: string,
    context: AgentContext,
    opts?: ChatStreamOptions
  ): Promise<string>;
  getHistory(): AgentHistory;
  setHistory(messages: AgentHistory): void;
  clearHistory(): void;
}
