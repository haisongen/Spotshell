/**
 * One-shot, inspectable compaction of older agent chat / completed tool output.
 * Summaries never re-enter as compaction input (ADR-046 / ADR-047).
 */

import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { estimateTokens } from '../agent/history.js';
import { estimateTextTokens } from './ContextAssembler.js';

/** Trigger automatic compaction when estimated input use reaches this share of budget. */
export const COMPACTION_TRIGGER_RATIO = 0.85;

/** Share of available input budget reserved for independent compaction summaries. */
export const COMPACTION_SUMMARY_BUDGET_RATIO = 0.15;

/** Keep at least this many recent human-turn groups verbatim. */
export const RECENT_TAIL_MIN_TURN_GROUPS = 2;

/** Prefer retaining at least this many tokens of recent verbatim history. */
export const RECENT_TAIL_MIN_TOKENS = 1_500;

export interface CompactionSummaryRecord {
  id: string;
  text: string;
  /** Stable ids of original agent-history messages covered by this summary. */
  coveredMessageIds: string[];
  coveredFromPreview: string;
  coveredToPreview: string;
  model: string;
  createdAt: string;
  estimatedTokens: number;
}

export type CompactionOverLimitReason =
  | 'auto_compact_disabled'
  | 'summary_budget_exhausted'
  | 'nothing_eligible';

export type CompactionPlan =
  | { action: 'none' }
  | { action: 'hint_over_limit'; reason: CompactionOverLimitReason }
  | {
      action: 'compact';
      toCompact: BaseMessage[];
      retain: BaseMessage[];
      remainingSummaryBudget: number;
    };

export interface PlanContextCompactionInput {
  allowAutoCompaction: boolean;
  usedInputTokens: number;
  availableInputBudget: number;
  chatBudgetTokens: number;
  history: readonly BaseMessage[];
  existingSummaries: readonly CompactionSummaryRecord[];
}

export function remainingSummaryBudgetTokens(
  availableInputBudget: number,
  existingSummaries: readonly CompactionSummaryRecord[],
): number {
  const total = Math.max(
    0,
    Math.floor(Math.max(0, availableInputBudget) * COMPACTION_SUMMARY_BUDGET_RATIO),
  );
  const used = existingSummaries.reduce((sum, item) => sum + Math.max(0, item.estimatedTokens), 0);
  return Math.max(0, total - used);
}

export function isOverCompactionTrigger(input: {
  usedInputTokens: number;
  availableInputBudget: number;
  chatBudgetTokens: number;
  historyTokens: number;
}): boolean {
  const available = Math.max(0, input.availableInputBudget);
  if (available <= 0) return true;
  if (input.usedInputTokens / available >= COMPACTION_TRIGGER_RATIO) return true;
  // History no longer fits the chat remainder assigned by the assembler.
  if (input.historyTokens > Math.max(0, input.chatBudgetTokens)) return true;
  return false;
}

export function ensureMessageIds(messages: readonly BaseMessage[]): BaseMessage[] {
  return messages.map((message, index) => {
    if (message.id) return message;
    const id = `hist-${index}-${simpleHash(messageContent(message))}`;
    return messageWithId(message, id);
  });
}

export function estimateMessagesTokens(messages: readonly BaseMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/**
 * Decide whether to compact, hint the user, or leave history alone.
 * Never mutates inputs. Does not generate summary text.
 */
export function planContextCompaction(input: PlanContextCompactionInput): CompactionPlan {
  const history = ensureMessageIds(input.history);
  const historyTokens = estimateMessagesTokens(history);
  const over = isOverCompactionTrigger({
    usedInputTokens: input.usedInputTokens,
    availableInputBudget: input.availableInputBudget,
    chatBudgetTokens: input.chatBudgetTokens,
    historyTokens,
  });
  if (!over) return { action: 'none' };

  if (!input.allowAutoCompaction) {
    return { action: 'hint_over_limit', reason: 'auto_compact_disabled' };
  }

  const remainingBudget = remainingSummaryBudgetTokens(
    input.availableInputBudget,
    input.existingSummaries,
  );
  // Need room for a non-trivial summary; empty budget means stop auto-compact.
  if (remainingBudget < 32) {
    return { action: 'hint_over_limit', reason: 'summary_budget_exhausted' };
  }

  const { toCompact, retain } = splitEligibleCompactionWindow(history);
  if (toCompact.length === 0) {
    return { action: 'hint_over_limit', reason: 'nothing_eligible' };
  }

  return {
    action: 'compact',
    toCompact,
    retain,
    remainingSummaryBudget: remainingBudget,
  };
}

/**
 * Older eligible human/AI/tool messages vs recent verbatim tail.
 * System messages and anything already treated as a summary stay out of toCompact.
 */
export function splitEligibleCompactionWindow(history: readonly BaseMessage[]): {
  toCompact: BaseMessage[];
  retain: BaseMessage[];
} {
  const { preamble, groups } = groupByHumanTurns(history);
  if (groups.length <= RECENT_TAIL_MIN_TURN_GROUPS) {
    return { toCompact: [], retain: [...history] };
  }

  let retainGroupCount = RECENT_TAIL_MIN_TURN_GROUPS;
  let retainTokens = groups
    .slice(-retainGroupCount)
    .reduce((sum, group) => sum + estimateMessagesTokens(group), 0);
  while (
    retainGroupCount < groups.length
    && retainTokens < RECENT_TAIL_MIN_TOKENS
  ) {
    retainGroupCount += 1;
    retainTokens = groups
      .slice(-retainGroupCount)
      .reduce((sum, group) => sum + estimateMessagesTokens(group), 0);
  }

  // Always leave at least one older group to compact when over the minimum tail.
  if (retainGroupCount >= groups.length) {
    retainGroupCount = Math.max(1, groups.length - 1);
  }

  const older = groups.slice(0, groups.length - retainGroupCount).flat();
  const recent = groups.slice(groups.length - retainGroupCount).flat();
  const toCompact = older.filter(isEligibleForCompaction);
  // Keep ineligible older messages (e.g. stray system) with the retain set so they are not dropped.
  const ineligibleOlder = older.filter((message) => !isEligibleForCompaction(message));
  return {
    toCompact,
    retain: [...preamble, ...ineligibleOlder, ...recent],
  };
}

export function isEligibleForCompaction(message: BaseMessage): boolean {
  if (SystemMessage.isInstance(message)) return false;
  if (isCompactionSummaryMessage(message)) return false;
  return (
    HumanMessage.isInstance(message)
    || AIMessage.isInstance(message)
    || ToolMessage.isInstance(message)
  );
}

export function isCompactionSummaryMessage(message: BaseMessage): boolean {
  const kwargs = message.additional_kwargs as Record<string, unknown> | undefined;
  return kwargs?.['spotshellCompaction'] === true;
}

export function buildCompactionSummaryRecord(input: {
  text: string;
  coveredMessages: readonly BaseMessage[];
  model: string;
  createdAt?: string;
  id?: string;
}): CompactionSummaryRecord {
  const text = input.text.trim();
  const coveredMessageIds = input.coveredMessages
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id));
  const first = input.coveredMessages[0];
  const last = input.coveredMessages[input.coveredMessages.length - 1];
  return {
    id: input.id ?? `compaction-${Date.now()}-${simpleHash(text)}`,
    text,
    coveredMessageIds,
    coveredFromPreview: previewContent(first),
    coveredToPreview: previewContent(last),
    model: input.model,
    createdAt: input.createdAt ?? new Date().toISOString(),
    estimatedTokens: estimateTextTokens(text),
  };
}

export function formatCompactionSummariesForContext(
  summaries: readonly CompactionSummaryRecord[],
  language: 'en' | 'zh-CN' = 'zh-CN',
): string | undefined {
  if (summaries.length === 0) return undefined;
  const header = language === 'en'
    ? '[Prior conversation summaries — not authoritative evidence]'
    : '[先前对话摘要 — 非权威证据]';
  const body = summaries.map((summary, index) => {
    const range = language === 'en'
      ? `Summary ${index + 1} (model: ${summary.model}; covers ${summary.coveredMessageIds.length} messages; ${summary.coveredFromPreview} … ${summary.coveredToPreview})`
      : `摘要 ${index + 1}（模型：${summary.model}；覆盖 ${summary.coveredMessageIds.length} 条消息；${summary.coveredFromPreview} … ${summary.coveredToPreview}）`;
    return `${range}\n${summary.text}`;
  }).join('\n\n');
  return `${header}\n\n${body}`;
}

/**
 * Split history into leading non-human preamble (always retained) and
 * human-turn groups. Only HumanMessage starts a compactable group so a lone
 * SystemMessage cannot starve eligible turns.
 */
function groupByHumanTurns(messages: readonly BaseMessage[]): {
  preamble: BaseMessage[];
  groups: BaseMessage[][];
} {
  const preamble: BaseMessage[] = [];
  const groups: BaseMessage[][] = [];
  let current: BaseMessage[] | null = null;
  for (const message of messages) {
    if (HumanMessage.isInstance(message)) {
      if (current) groups.push(current);
      current = [message];
      continue;
    }
    if (current) {
      current.push(message);
    } else {
      preamble.push(message);
    }
  }
  if (current) groups.push(current);
  return { preamble, groups };
}

function messageContent(message: BaseMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);
}

function previewContent(message: BaseMessage | undefined): string {
  if (!message) return '';
  const raw = messageContent(message).replace(/\s+/g, ' ').trim();
  if (raw.length <= 80) return raw;
  return `${raw.slice(0, 77)}...`;
}

function messageWithId(message: BaseMessage, id: string): BaseMessage {
  if (HumanMessage.isInstance(message)) {
    return new HumanMessage({
      content: message.content,
      id,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      name: message.name,
    });
  }
  if (AIMessage.isInstance(message)) {
    return new AIMessage({
      content: message.content,
      id,
      tool_calls: message.tool_calls,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      name: message.name,
    });
  }
  if (ToolMessage.isInstance(message)) {
    return new ToolMessage({
      content: message.content,
      tool_call_id: message.tool_call_id,
      id,
      name: message.name,
      status: message.status,
      artifact: message.artifact,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  }
  if (SystemMessage.isInstance(message)) {
    return new SystemMessage({
      content: message.content,
      id,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      name: message.name,
    });
  }
  return message;
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
