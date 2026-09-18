/**
 * TEMPORARY bridge between `AgentMessage` and `@langchain/core` messages.
 *
 * Only `SpotShellAgent` may import this file, and only at the boundary where it
 * hands messages to / receives messages from the LangGraph runtime. It is meant
 * to be deleted once the runtime itself stops speaking langchain — do not grow
 * features here.
 */

import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { z } from 'zod';
import {
  withMessageId,
  type AgentMessage,
  type AgentToolCall,
} from './message.js';
import { sanitizeToolCallIndices } from './history.js';
import type { AgentToolDefinition } from './types.js';

function contentToText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export function toLangchain(messages: readonly AgentMessage[]): BaseMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
        return new SystemMessage({ content: message.text, id: message.id });
      case 'user':
        return new HumanMessage({ content: message.text, id: message.id });
      case 'assistant':
        return new AIMessage({
          content: message.text,
          id: message.id,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            args: (call.arguments ?? {}) as Record<string, unknown>,
            type: 'tool_call' as const,
          })),
        });
      case 'toolResult':
        return new ToolMessage({
          content: message.text,
          tool_call_id: message.toolCallId,
          id: message.id,
          ...(message.toolName ? { name: message.toolName } : {}),
          status: message.isError ? 'error' : 'success',
        });
    }
  });
}

export function fromLangchain(messages: readonly BaseMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const timestamp = Date.now();
    if (ToolMessage.isInstance(message)) {
      return applyId(message, withMessageId({
        role: 'toolResult',
        toolCallId: message.tool_call_id,
        toolName: message.name ?? '',
        text: contentToText(message.content),
        isError: message.status === 'error',
        timestamp,
      }));
    }
    if (AIMessage.isInstance(message)) {
      const toolCalls: AgentToolCall[] = (message.tool_calls ?? []).map((call) => ({
        id: call.id ?? '',
        name: call.name,
        arguments: call.args,
      }));
      return applyId(message, withMessageId({
        role: 'assistant',
        text: contentToText(message.content),
        toolCalls,
        timestamp,
      }));
    }
    if (SystemMessage.isInstance(message)) {
      return applyId(message, withMessageId({
        role: 'system',
        text: contentToText(message.content),
        timestamp,
      }));
    }
    return applyId(message, withMessageId({
      role: 'user',
      text: contentToText(message.content),
      timestamp,
    }));
  });
}

/**
 * Sanitize a langchain history using the shared `AgentMessage` rules while
 * returning the *original* langchain objects, so provider-specific fields
 * (content blocks, response metadata) survive untouched.
 */
export function sanitizeLangchainHistory(messages: readonly BaseMessage[]): BaseMessage[] {
  return sanitizeToolCallIndices(fromLangchain(messages)).map((index) => messages[index]!);
}

type ToolFactory = (
  func: (input: any) => Promise<string>,
  fields: { name: string; description: string; schema: z.ZodTypeAny },
) => StructuredToolInterface;

const makeLangchainTool = tool as unknown as ToolFactory;

export function toLangchainTools(
  definitions: readonly AgentToolDefinition[],
): StructuredToolInterface[] {
  return definitions.map((definition) => makeLangchainTool(
    (input) => definition.execute(input),
    {
      name: definition.name,
      description: definition.description,
      schema: definition.schema,
    },
  ));
}

/** Preserve an id the framework already assigned; otherwise keep the derived one. */
function applyId<T extends AgentMessage>(source: BaseMessage, message: T): T {
  return source.id ? { ...message, id: source.id } : message;
}
