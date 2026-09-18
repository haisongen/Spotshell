import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantMessage,
  isAssistant,
  isSystem,
  isToolResult,
  isUser,
  makeMessageId,
  messageText,
  systemMessage,
  toolResultMessage,
  userMessage,
  type AgentMessage,
} from './message.js';
import { fromLangchain, toLangchain } from './langchainAdapter.js';

function sampleHistory(): AgentMessage[] {
  return [
    systemMessage('You are SpotShell.', 1_000),
    userMessage('check disk usage and uptime', 1_001),
    assistantMessage(
      'Running two checks.',
      [
        { id: 'call-1', name: 'execute_ssh_command', arguments: { command: 'df -h' } },
        { id: 'call-2', name: 'execute_ssh_command', arguments: { command: 'uptime' } },
      ],
      1_002,
    ),
    toolResultMessage({ toolCallId: 'call-1', toolName: 'execute_ssh_command', text: '/dev/sda1 42%' }, 1_003),
    toolResultMessage(
      { toolCallId: 'call-2', toolName: 'execute_ssh_command', text: 'boom', isError: true },
      1_004,
    ),
    assistantMessage('Disk is at 42%; uptime lookup failed.', [], 1_005),
  ];
}

describe('AgentMessage discriminators', () => {
  it('narrows by role', () => {
    const messages = sampleHistory();
    assert.equal(messages.filter(isSystem).length, 1);
    assert.equal(messages.filter(isUser).length, 1);
    assert.equal(messages.filter(isAssistant).length, 2);
    assert.equal(messages.filter(isToolResult).length, 2);
  });

  it('messageText returns the plain body', () => {
    assert.equal(messageText(userMessage('hello')), 'hello');
  });
});

describe('makeMessageId', () => {
  it('is derived from content only, never from position', () => {
    const a = userMessage('same body', 1);
    const b = userMessage('same body', 999_999);
    assert.equal(a.id, b.id);
  });

  it('separates different roles and different bodies', () => {
    assert.notEqual(userMessage('x').id, assistantMessage('x').id);
    assert.notEqual(userMessage('x').id, userMessage('y').id);
  });

  it('distinguishes assistant messages by their tool calls', () => {
    const withoutCalls = assistantMessage('');
    const withCall = assistantMessage('', [{ id: 'c1', name: 'run', arguments: { a: 1 } }]);
    const otherArgs = assistantMessage('', [{ id: 'c1', name: 'run', arguments: { a: 2 } }]);
    assert.notEqual(withoutCalls.id, withCall.id);
    assert.notEqual(withCall.id, otherArgs.id);
  });

  it('distinguishes tool results by the call they answer', () => {
    const first = toolResultMessage({ toolCallId: 'c1', toolName: 'run', text: 'ok' });
    const second = toolResultMessage({ toolCallId: 'c2', toolName: 'run', text: 'ok' });
    assert.notEqual(first.id, second.id);
  });

  it('survives trimming: an id does not change when earlier messages are removed', () => {
    const history = sampleHistory();
    const trimmed = history.slice(3);
    for (const [index, message] of trimmed.entries()) {
      assert.equal(message.id, history[index + 3]!.id);
      assert.equal(message.id, makeMessageId(message));
    }
  });
});

describe('langchain adapter round trip', () => {
  it('preserves ids, roles, content and tool_call pairing', () => {
    const original = sampleHistory();
    const restored = fromLangchain(toLangchain(original));

    // Timestamps are not carried by langchain messages; everything else must match.
    assert.deepEqual(
      restored.map((m) => ({ ...m, timestamp: 0 })),
      original.map((m) => ({ ...m, timestamp: 0 })),
    );
    assert.deepEqual(restored.map((m) => m.id), original.map((m) => m.id));
    assert.ok(restored.every((m) => typeof m.timestamp === 'number'));
  });

  it('keeps tool calls paired with their results across the round trip', () => {
    const restored = fromLangchain(toLangchain(sampleHistory()));
    const calls = restored.filter(isAssistant).flatMap((m) => m.toolCalls);
    const results = restored.filter(isToolResult);
    assert.deepEqual(calls.map((c) => c.id), ['call-1', 'call-2']);
    assert.deepEqual(results.map((r) => r.toolCallId), ['call-1', 'call-2']);
    assert.deepEqual(calls.map((c) => c.arguments), [{ command: 'df -h' }, { command: 'uptime' }]);
    assert.deepEqual(results.map((r) => r.isError), [false, true]);
    assert.deepEqual(results.map((r) => r.toolName), ['execute_ssh_command', 'execute_ssh_command']);
  });

  it('round trips an empty history and a lone message', () => {
    assert.deepEqual(fromLangchain(toLangchain([])), []);
    const lone = [userMessage('solo', 7)];
    const restored = fromLangchain(toLangchain(lone));
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.text, 'solo');
    assert.equal(restored[0]?.id, lone[0]!.id);
  });

  it('is idempotent when applied twice', () => {
    const once = fromLangchain(toLangchain(sampleHistory()));
    const twice = fromLangchain(toLangchain(once));
    assert.deepEqual(
      twice.map((m) => ({ ...m, timestamp: 0 })),
      once.map((m) => ({ ...m, timestamp: 0 })),
    );
  });
});
