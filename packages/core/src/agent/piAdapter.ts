/**
 * Bridge between SpotShell's own `AgentMessage` model and the pi runtime.
 *
 * Only `SpotShellAgent` may import this file, and only at the boundary where it
 * hands messages to / receives messages from `@earendil-works/pi-agent-core`.
 * Everything above that boundary stays framework neutral.
 *
 * All imports here are type-only on purpose: pi-ai and pi-agent-core declare an
 * `import`-only export condition, so a value import would make the whole
 * `@spotshell/core` barrel unloadable from a CommonJS context (the Electron
 * main-process test runner). Types are erased at compile time; the few runtime
 * values pi needs are loaded through `import()` in `SpotShellAgent`.
 */

import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  ImageContent,
  Message as PiMessage,
  ProviderId,
  TextContent,
  ToolCall as PiToolCall,
  ToolResultMessage as PiToolResultMessage,
  UserMessage as PiUserMessage,
} from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  withMessageId,
  type AgentMessage,
  type AgentToolCall,
} from './message.js';
import { sanitizeToolCallIndices, trimHistoryIndicesToBudget } from './history.js';
import type { AgentToolDefinition } from './types.js';

/** Identity stamped onto assistant messages that SpotShell replays into pi. */
export interface PiAssistantOrigin {
  api: Api;
  provider: ProviderId;
  model: string;
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function textOf(content: readonly (TextContent | ImageContent)[]): string {
  return content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Plain text of an assistant message, ignoring thinking and tool-call blocks. */
export function assistantText(message: PiAssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function userText(message: PiUserMessage): string {
  return typeof message.content === 'string' ? message.content : textOf(message.content);
}

/**
 * `AgentMessage` -> pi `Message`.
 *
 * System messages are dropped: pi 0.85.1 has no system role in the transcript —
 * `Context.systemPrompt` carries it instead, and `SpotShellAgent` assigns that
 * separately each turn. Callers must not rely on system content surviving here.
 */
export function toPiMessages(
  messages: readonly AgentMessage[],
  origin: PiAssistantOrigin,
): PiMessage[] {
  const converted: PiMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        continue;
      case 'user':
        converted.push({
          role: 'user',
          content: message.text,
          timestamp: message.timestamp,
        });
        continue;
      case 'assistant': {
        const content: PiAssistantMessage['content'] = [];
        if (message.text) content.push({ type: 'text', text: message.text });
        for (const call of message.toolCalls) {
          content.push({
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: (call.arguments ?? {}) as Record<string, unknown>,
          });
        }
        converted.push({
          role: 'assistant',
          content,
          api: origin.api,
          provider: origin.provider,
          model: origin.model,
          usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
          stopReason: message.toolCalls.length > 0 ? 'toolUse' : 'stop',
          timestamp: message.timestamp,
        });
        continue;
      }
      case 'toolResult':
        converted.push({
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: [{ type: 'text', text: message.text }],
          isError: message.isError,
          timestamp: message.timestamp,
        });
        continue;
    }
  }
  return converted;
}

export function fromPiMessages(messages: readonly PiMessage[]): AgentMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'user':
        return withMessageId({
          role: 'user',
          text: userText(message),
          timestamp: message.timestamp,
        });
      case 'assistant': {
        const toolCalls: AgentToolCall[] = message.content
          .filter((block): block is PiToolCall => block.type === 'toolCall')
          .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }));
        return withMessageId({
          role: 'assistant',
          text: assistantText(message),
          toolCalls,
          timestamp: message.timestamp,
        });
      }
      case 'toolResult':
        return withMessageId({
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          text: textOf(message.content),
          isError: message.isError,
          timestamp: message.timestamp,
        });
    }
  });
}

/**
 * Apply `sanitizeToolCallIndices` to a pi transcript while returning the
 * *original* pi objects, so provider-specific fields (thinking signatures,
 * usage, response ids) survive untouched.
 */
export function sanitizePiMessages(messages: readonly PiMessage[]): PiMessage[] {
  return sanitizeToolCallIndices(fromPiMessages(messages)).map((index) => messages[index]!);
}

/** Same index-preserving trick for the outbound budget trim. */
export function trimPiMessagesToBudget(
  messages: readonly PiMessage[],
  budgetTokens: number,
): PiMessage[] {
  return trimHistoryIndicesToBudget(fromPiMessages(messages), budgetTokens)
    .map((index) => messages[index]!);
}

/**
 * Cap a tool result's text so a single oversized output cannot blow up the
 * turn it is produced in. Image blocks pass through untouched; the combined
 * text is capped as one unit so the limit matches `capToolMessage`.
 */
export function capToolResultContent(
  content: readonly (TextContent | ImageContent)[],
  maxChars: number,
): (TextContent | ImageContent)[] | undefined {
  const text = textOf(content);
  if (text.length <= maxChars) return undefined;
  const omitted = text.length - maxChars;
  const capped = `${text.slice(0, maxChars)}...[truncated ${omitted} chars]`;
  const images = content.filter((block): block is ImageContent => block.type === 'image');
  return [{ type: 'text', text: capped }, ...images];
}

/**
 * `AgentToolDefinition` -> pi `AgentTool`.
 *
 * The TypeBox schema is handed over unchanged; pi validates tool arguments
 * against it before `execute` runs, which is the same guarantee the previous
 * LangChain adapter relied on. SpotShell tools return a formatted string and
 * report their own failures in that string, so nothing is thrown here.
 */
export function toPiTools(definitions: readonly AgentToolDefinition[]): AgentTool<any>[] {
  return definitions.map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.schema,
    execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      const output = await definition.execute(params);
      return { content: [{ type: 'text', text: output }], details: {} };
    },
  }));
}
