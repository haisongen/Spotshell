/**
 * SpotShell's own agent message model.
 *
 * A discriminated union on `role` replaces the langchain `BaseMessage` family so
 * history, trimming and compaction algorithms stay framework independent. The
 * only place that still speaks langchain is `SpotShellAgent` plus the temporary
 * `langchainAdapter`.
 */

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

interface AgentMessageBase {
  /** Stable identity derived from message content; see `makeMessageId`. */
  id: string;
  /** Unix milliseconds. */
  timestamp: number;
}

export interface AgentSystemMessage extends AgentMessageBase {
  role: 'system';
  text: string;
}

export interface AgentUserMessage extends AgentMessageBase {
  role: 'user';
  text: string;
}

export interface AgentAssistantMessage extends AgentMessageBase {
  role: 'assistant';
  text: string;
  toolCalls: AgentToolCall[];
}

export interface AgentToolResultMessage extends AgentMessageBase {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  text: string;
  isError: boolean;
}

export type AgentMessage =
  | AgentSystemMessage
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolResultMessage;

/** A message before its content-derived id has been computed. */
export type AgentMessageDraft =
  | Omit<AgentSystemMessage, 'id'>
  | Omit<AgentUserMessage, 'id'>
  | Omit<AgentAssistantMessage, 'id'>
  | Omit<AgentToolResultMessage, 'id'>;

export const isSystem = (m: AgentMessage): m is AgentSystemMessage => m.role === 'system';
export const isUser = (m: AgentMessage): m is AgentUserMessage => m.role === 'user';
export const isAssistant = (m: AgentMessage): m is AgentAssistantMessage => m.role === 'assistant';
export const isToolResult = (m: AgentMessage): m is AgentToolResultMessage => m.role === 'toolResult';

export function messageText(m: AgentMessage): string {
  return m.text;
}

/**
 * Content-derived stable id. Deliberately free of any array index so trimming or
 * compacting history never invalidates ids already referenced by
 * `CompactionSummaryRecord.coveredMessageIds`.
 *
 * Two messages with identical content collide by design; ids are used for
 * display and de-duplication, never for addressing.
 */
export function makeMessageId(m: AgentMessageDraft): string {
  const parts: string[] = [m.role, m.text];
  if (m.role === 'assistant') {
    parts.push(JSON.stringify(m.toolCalls.map((call) => [call.id, call.name, call.arguments])));
  }
  if (m.role === 'toolResult') {
    parts.push(m.toolCallId, m.toolName);
  }
  return `msg-${simpleHash(parts.join('\u0000'))}`;
}

/** Attach the content-derived id to a draft message. */
export function withMessageId<T extends AgentMessageDraft>(draft: T): T & { id: string } {
  return { ...draft, id: makeMessageId(draft) };
}

export function systemMessage(text: string, timestamp: number = Date.now()): AgentSystemMessage {
  return withMessageId({ role: 'system', text, timestamp });
}

export function userMessage(text: string, timestamp: number = Date.now()): AgentUserMessage {
  return withMessageId({ role: 'user', text, timestamp });
}

export function assistantMessage(
  text: string,
  toolCalls: readonly AgentToolCall[] = [],
  timestamp: number = Date.now(),
): AgentAssistantMessage {
  return withMessageId({ role: 'assistant', text, toolCalls: [...toolCalls], timestamp });
}

export function toolResultMessage(
  input: {
    toolCallId: string;
    toolName?: string;
    text: string;
    isError?: boolean;
  },
  timestamp: number = Date.now(),
): AgentToolResultMessage {
  return withMessageId({
    role: 'toolResult',
    toolCallId: input.toolCallId,
    toolName: input.toolName ?? '',
    text: input.text,
    isError: input.isError ?? false,
    timestamp,
  });
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
