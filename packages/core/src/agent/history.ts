import {
  isAssistant,
  isToolResult,
  isUser,
  withMessageId,
  type AgentMessage,
  type AgentToolResultMessage,
} from './message.js';

function serializedLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

export function estimateTokens(message: AgentMessage): number {
  let chars = serializedLength(message.text);
  if (isAssistant(message) && message.toolCalls.length > 0) {
    chars += serializedLength(message.toolCalls);
  }
  return Math.ceil(chars / 4);
}

export function capToolMessage(
  msg: AgentToolResultMessage,
  maxChars: number,
): AgentToolResultMessage {
  const content = msg.text;
  if (content.length <= maxChars) return msg;
  const omitted = content.length - maxChars;
  return withMessageId({
    role: 'toolResult',
    toolCallId: msg.toolCallId,
    toolName: msg.toolName,
    text: `${content.slice(0, maxChars)}...[truncated ${omitted} chars]`,
    isError: msg.isError,
    timestamp: msg.timestamp,
  });
}

/**
 * Indices of the messages that survive tool-call sanitization, in order.
 *
 * Exposed separately from `sanitizeToolCallHistory` so a caller holding
 * framework-native messages (the langchain adapter) can apply the very same
 * decision without reconstructing its own objects.
 */
export function sanitizeToolCallIndices(messages: readonly AgentMessage[]): number[] {
  const keep: number[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;
    if (isToolResult(message)) {
      // Orphan tool result: no immediately preceding tool-calling assistant turn.
      index += 1;
      continue;
    }

    if (isAssistant(message) && message.toolCalls.length > 0) {
      const expectedIds = message.toolCalls.map((call) => call.id).filter(Boolean);
      const toolIndices: number[] = [];
      let nextIndex = index + 1;
      while (nextIndex < messages.length && isToolResult(messages[nextIndex]!)) {
        toolIndices.push(nextIndex);
        nextIndex += 1;
      }

      const receivedIds = toolIndices.map((i) => (messages[i] as AgentToolResultMessage).toolCallId);
      const complete = expectedIds.length === message.toolCalls.length
        && receivedIds.length === expectedIds.length
        && new Set(receivedIds).size === receivedIds.length
        && receivedIds.every((id) => expectedIds.includes(id));
      if (complete) keep.push(index, ...toolIndices);
      index = nextIndex;
      continue;
    }

    keep.push(index);
    index += 1;
  }

  return keep;
}

/**
 * Remove incomplete tool-call batches that OpenAI rejects as invalid history.
 * A tool-calling assistant message is atomic with the consecutive tool results
 * for every declared call id; orphan or partial tool results are discarded too.
 */
export function sanitizeToolCallHistory(messages: readonly AgentMessage[]): AgentMessage[] {
  return sanitizeToolCallIndices(messages).map((index) => messages[index]!);
}

/**
 * Indices of the messages that survive sanitization *and* budget trimming, in
 * order. Exposed alongside `trimHistoryToBudget` for the same reason as
 * `sanitizeToolCallIndices`: a caller holding framework-native messages (the pi
 * adapter) can apply the identical decision without rebuilding its own objects,
 * so provider-specific fields survive the round trip untouched.
 */
export function trimHistoryIndicesToBudget(
  messages: readonly AgentMessage[],
  budgetTokens: number,
): number[] {
  const validIndices = sanitizeToolCallIndices(messages);
  if (validIndices.length === 0) return [];

  const groups: number[][] = [];
  let current: number[] = [];
  for (const index of validIndices) {
    if (isUser(messages[index]!) && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(index);
  }
  if (current.length > 0) groups.push(current);

  const groupTokens = (group: readonly number[]): number =>
    group.reduce((sum, index) => sum + estimateTokens(messages[index]!), 0);

  let total = groups.reduce((sum, group) => sum + groupTokens(group), 0);
  while (groups.length > 1 && total > budgetTokens) {
    total -= groupTokens(groups.shift()!);
  }

  return groups.flat();
}

export function trimHistoryToBudget(
  messages: readonly AgentMessage[],
  budgetTokens: number,
): AgentMessage[] {
  return trimHistoryIndicesToBudget(messages, budgetTokens).map((index) => messages[index]!);
}
