import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  estimateTokens,
  trimHistoryToBudget,
  capToolMessage,
  sanitizeToolCallHistory,
} from './history.js';

describe('history utilities', () => {
  it('estimateTokens approximates chars/4', () => {
    assert.equal(estimateTokens(new HumanMessage('a'.repeat(400))), 100);
  });

  it('trims oldest turns first and keeps within budget', () => {
    const messages = [
      new HumanMessage('old '.repeat(200)),
      new AIMessage('old answer '.repeat(200)),
      new HumanMessage('recent question'),
      new AIMessage('recent answer'),
    ];
    const trimmed = trimHistoryToBudget(messages, 50);
    assert.ok(trimmed.length < messages.length);
    assert.equal((trimmed.at(-1) as AIMessage).content, 'recent answer');
    assert.equal((trimmed.at(-2) as HumanMessage).content, 'recent question');
  });

  it('never splits an AI tool_calls message from its ToolMessages', () => {
    const ai = new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'x', args: {} }] });
    const tool = new ToolMessage({ tool_call_id: 't1', content: 'result '.repeat(100) });
    const messages = [
      new HumanMessage('q1 '.repeat(300)),
      ai,
      tool,
      new HumanMessage('q2'),
      new AIMessage('a2'),
    ];
    const trimmed = trimHistoryToBudget(messages, 60);
    const hasAi = trimmed.includes(ai);
    const hasTool = trimmed.includes(tool);
    assert.equal(hasAi, hasTool);
  });

  it('drops an incomplete multi-tool batch and its partial results', () => {
    const human = new HumanMessage('inspect host');
    const incompleteAi = new AIMessage({
      content: '',
      tool_calls: [
        { id: 't1', name: 'first', args: {} },
        { id: 't2', name: 'second', args: {} },
      ],
    });
    const partialResult = new ToolMessage({ tool_call_id: 't1', content: 'first result' });
    const finalAnswer = new AIMessage('prior answer');

    assert.deepEqual(
      sanitizeToolCallHistory([human, incompleteAi, partialResult, finalAnswer]),
      [human, finalAnswer],
    );
  });

  it('keeps a complete multi-tool batch and removes orphan tool results', () => {
    const ai = new AIMessage({
      content: '',
      tool_calls: [
        { id: 't1', name: 'first', args: {} },
        { id: 't2', name: 'second', args: {} },
      ],
    });
    const first = new ToolMessage({ tool_call_id: 't1', content: 'first result' });
    const second = new ToolMessage({ tool_call_id: 't2', content: 'second result' });
    const orphan = new ToolMessage({ tool_call_id: 'missing', content: 'orphan' });

    assert.deepEqual(sanitizeToolCallHistory([orphan, ai, first, second]), [ai, first, second]);
  });

  it('caps oversized tool outputs with a truncation note', () => {
    const capped = capToolMessage(
      new ToolMessage({ tool_call_id: 't', content: 'x'.repeat(5000) }),
      2000
    );
    assert.ok(String(capped.content).length <= 2000 + 50);
    assert.match(String(capped.content), /truncated/);
  });
});
