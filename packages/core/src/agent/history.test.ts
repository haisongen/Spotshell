import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantMessage,
  toolResultMessage,
  userMessage,
  type AgentMessage,
} from './message.js';
import {
  estimateTokens,
  trimHistoryToBudget,
  capToolMessage,
  sanitizeToolCallHistory,
} from './history.js';

function toolCallingAssistant(text: string, calls: Array<{ id: string; name: string }>) {
  return assistantMessage(text, calls.map((call) => ({ ...call, arguments: {} })));
}

describe('history utilities', () => {
  it('estimateTokens approximates chars/4', () => {
    assert.equal(estimateTokens(userMessage('a'.repeat(400))), 100);
  });

  it('estimateTokens also charges for assistant tool calls', () => {
    const plain = assistantMessage('answer');
    const withCalls = toolCallingAssistant('answer', [{ id: 't1', name: 'execute_ssh_command' }]);
    assert.ok(estimateTokens(withCalls) > estimateTokens(plain));
  });

  it('trims oldest turns first and keeps within budget', () => {
    const messages = [
      userMessage('old '.repeat(200)),
      assistantMessage('old answer '.repeat(200)),
      userMessage('recent question'),
      assistantMessage('recent answer'),
    ];
    const trimmed = trimHistoryToBudget(messages, 50);
    assert.ok(trimmed.length < messages.length);
    assert.equal(trimmed.at(-1)?.text, 'recent answer');
    assert.equal(trimmed.at(-2)?.text, 'recent question');
  });

  it('never splits an assistant tool_calls message from its tool results', () => {
    const ai = toolCallingAssistant('', [{ id: 't1', name: 'x' }]);
    const tool = toolResultMessage({ toolCallId: 't1', toolName: 'x', text: 'result '.repeat(100) });
    const messages = [
      userMessage('q1 '.repeat(300)),
      ai,
      tool,
      userMessage('q2'),
      assistantMessage('a2'),
    ];
    const trimmed = trimHistoryToBudget(messages, 60);
    assert.equal(trimmed.includes(ai), trimmed.includes(tool));
  });

  it('drops an incomplete multi-tool batch and its partial results', () => {
    const human = userMessage('inspect host');
    const incompleteAi = toolCallingAssistant('', [
      { id: 't1', name: 'first' },
      { id: 't2', name: 'second' },
    ]);
    const partialResult = toolResultMessage({ toolCallId: 't1', toolName: 'first', text: 'first result' });
    const finalAnswer = assistantMessage('prior answer');

    assert.deepEqual(
      sanitizeToolCallHistory([human, incompleteAi, partialResult, finalAnswer]),
      [human, finalAnswer],
    );
  });

  it('keeps a complete multi-tool batch and removes orphan tool results', () => {
    const ai = toolCallingAssistant('', [
      { id: 't1', name: 'first' },
      { id: 't2', name: 'second' },
    ]);
    const first = toolResultMessage({ toolCallId: 't1', toolName: 'first', text: 'first result' });
    const second = toolResultMessage({ toolCallId: 't2', toolName: 'second', text: 'second result' });
    const orphan = toolResultMessage({ toolCallId: 'missing', toolName: 'gone', text: 'orphan' });

    assert.deepEqual(sanitizeToolCallHistory([orphan, ai, first, second]), [ai, first, second]);
  });

  it('accepts a complete batch whose results arrive out of declaration order', () => {
    const ai = toolCallingAssistant('', [
      { id: 't1', name: 'first' },
      { id: 't2', name: 'second' },
    ]);
    const second = toolResultMessage({ toolCallId: 't2', toolName: 'second', text: 'second result' });
    const first = toolResultMessage({ toolCallId: 't1', toolName: 'first', text: 'first result' });

    assert.deepEqual(sanitizeToolCallHistory([ai, second, first]), [ai, second, first]);
  });

  it('drops a batch whose results duplicate one call id instead of covering both', () => {
    const ai = toolCallingAssistant('', [
      { id: 't1', name: 'first' },
      { id: 't2', name: 'second' },
    ]);
    const dup1 = toolResultMessage({ toolCallId: 't1', toolName: 'first', text: 'a' });
    const dup2 = toolResultMessage({ toolCallId: 't1', toolName: 'first', text: 'b' });

    assert.deepEqual(sanitizeToolCallHistory([ai, dup1, dup2]), []);
  });

  it('drops a trailing tool-calling assistant message with no results at all', () => {
    const human = userMessage('q');
    const dangling = toolCallingAssistant('', [{ id: 't1', name: 'first' }]);

    assert.deepEqual(sanitizeToolCallHistory([human, dangling]), [human]);
  });

  it('sanitizes several batches independently', () => {
    const goodAi = toolCallingAssistant('', [{ id: 'a1', name: 'first' }]);
    const goodResult = toolResultMessage({ toolCallId: 'a1', toolName: 'first', text: 'ok' });
    const badAi = toolCallingAssistant('', [
      { id: 'b1', name: 'first' },
      { id: 'b2', name: 'second' },
    ]);
    const badResult = toolResultMessage({ toolCallId: 'b1', toolName: 'first', text: 'half' });
    const answer = assistantMessage('done');
    const history: AgentMessage[] = [goodAi, goodResult, badAi, badResult, answer];

    assert.deepEqual(sanitizeToolCallHistory(history), [goodAi, goodResult, answer]);
  });

  it('leaves history without tool calls untouched', () => {
    const history = [userMessage('q'), assistantMessage('a')];
    assert.deepEqual(sanitizeToolCallHistory(history), history);
  });

  it('caps oversized tool outputs with a truncation note', () => {
    const capped = capToolMessage(
      toolResultMessage({ toolCallId: 't', toolName: 'x', text: 'x'.repeat(5000) }),
      2000,
    );
    assert.ok(capped.text.length <= 2000 + 50);
    assert.match(capped.text, /truncated/);
    assert.equal(capped.toolCallId, 't');
    assert.equal(capped.toolName, 'x');
  });

  it('leaves a tool output under the cap untouched', () => {
    const original = toolResultMessage({ toolCallId: 't', toolName: 'x', text: 'short' });
    assert.equal(capToolMessage(original, 2000), original);
  });
});
