import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

function serializedLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

export function estimateTokens(message: BaseMessage): number {
  let chars = serializedLength(message.content);
  if (AIMessage.isInstance(message) && message.tool_calls?.length) {
    chars += serializedLength(message.tool_calls);
  }
  return Math.ceil(chars / 4);
}

export function capToolMessage(msg: ToolMessage, maxChars: number): ToolMessage {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  if (content.length <= maxChars) return msg;
  const omitted = content.length - maxChars;
  return new ToolMessage({
    content: `${content.slice(0, maxChars)}...[truncated ${omitted} chars]`,
    tool_call_id: msg.tool_call_id,
    name: msg.name,
    status: msg.status,
    artifact: msg.artifact,
    metadata: msg.metadata,
    additional_kwargs: msg.additional_kwargs,
    response_metadata: msg.response_metadata,
    id: msg.id,
  });
}

/**
 * Remove incomplete tool-call batches that OpenAI rejects as invalid history.
 * A tool-calling AI message is atomic with the consecutive ToolMessages for
 * every declared call id; orphan or partial tool results are discarded too.
 */
export function sanitizeToolCallHistory(messages: readonly BaseMessage[]): BaseMessage[] {
  const sanitized: BaseMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;
    if (ToolMessage.isInstance(message)) {
      index += 1;
      continue;
    }

    if (AIMessage.isInstance(message) && message.tool_calls?.length) {
      const expectedIds = message.tool_calls.map((call) => call.id).filter(Boolean);
      const toolMessages: ToolMessage[] = [];
      let nextIndex = index + 1;
      while (nextIndex < messages.length && ToolMessage.isInstance(messages[nextIndex]!)) {
        toolMessages.push(messages[nextIndex] as ToolMessage);
        nextIndex += 1;
      }

      const receivedIds = toolMessages.map((toolMessage) => toolMessage.tool_call_id);
      const complete = expectedIds.length === message.tool_calls.length
        && receivedIds.length === expectedIds.length
        && new Set(receivedIds).size === receivedIds.length
        && receivedIds.every((id) => expectedIds.includes(id));
      if (complete) sanitized.push(message, ...toolMessages);
      index = nextIndex;
      continue;
    }

    sanitized.push(message);
    index += 1;
  }

  return sanitized;
}

export function trimHistoryToBudget(messages: BaseMessage[], budgetTokens: number): BaseMessage[] {
  const validMessages = sanitizeToolCallHistory(messages);
  if (validMessages.length === 0) return [];

  const groups: BaseMessage[][] = [];
  let current: BaseMessage[] = [];
  for (const message of validMessages) {
    if (HumanMessage.isInstance(message) && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);

  let total = groups.reduce(
    (sum, group) => sum + group.reduce((groupSum, message) => groupSum + estimateTokens(message), 0),
    0
  );
  while (groups.length > 1 && total > budgetTokens) {
    const removed = groups.shift()!;
    total -= removed.reduce((sum, message) => sum + estimateTokens(message), 0);
  }

  return groups.flat();
}
