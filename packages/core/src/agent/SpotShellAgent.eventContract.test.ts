/**
 * End-to-end contract test for the pi-backed runtime.
 *
 * `SessionManager` consumes `AgentStreamEvent` and `getHistory()` directly, so
 * this file pins both for the four paths that matter: a plain text reply, a
 * turn with two tool calls whose executions finish out of order, cancellation,
 * and a provider failure. It drives the real pi agent loop through a scripted
 * `fauxProvider()`, so nothing about the event protocol is mocked away.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotShellAgent, AgentCancelledError } from './SpotShellAgent.js';
import type { AgentStreamEvent, SSHExecutor } from './types.js';
import { isAssistant, isToolResult, isUser, type AgentMessage } from './message.js';
import { createFauxModelProvider, loadPiAi } from '../testing/fauxModelProvider.js';

class OrderedSshExecutor implements SSHExecutor {
  readonly started: string[] = [];
  readonly finished: string[] = [];

  constructor(private readonly delays: Record<string, number> = {}) {}

  async execute(command: string) {
    this.started.push(command);
    const delay = this.delays[command] ?? 0;
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    this.finished.push(command);
    return {
      command,
      stdout: `output of ${command}`,
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    };
  }

  async write(): Promise<boolean> {
    return true;
  }
}

function collect(
  agent: SpotShellAgent,
  input: string,
  signal?: AbortSignal,
): { events: AgentStreamEvent[]; reply: Promise<string> } {
  const events: AgentStreamEvent[] = [];
  const reply = agent.chatStream(input, { terminalHistory: '' }, {
    onEvent: (event) => events.push(event),
    ...(signal ? { signal } : {}),
  });
  return { events, reply };
}

/** Concatenated text of every `token` event, in arrival order. */
function streamedText(events: readonly AgentStreamEvent[]): string {
  return events
    .filter((event): event is { type: 'token'; text: string } => event.type === 'token')
    .map((event) => event.text)
    .join('');
}

const describe = (message: AgentMessage): string => {
  if (isUser(message)) return `user:${message.text}`;
  if (isAssistant(message)) {
    const calls = message.toolCalls.map((call) => call.name).join('+');
    return `assistant:${message.text}${calls ? `[${calls}]` : ''}`;
  }
  if (isToolResult(message)) return `tool:${message.toolName}:${message.text}`;
  return `system:${message.text}`;
};

test('event contract: a plain text turn streams tokens then one final event', async () => {
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({
    responses: [fauxAssistantMessage('the host is healthy')],
  });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    new OrderedSshExecutor(),
    undefined,
    { providerResolver: () => faux.provider },
  );

  const { events, reply } = collect(agent, 'how is the host');
  assert.equal(await reply, 'the host is healthy');

  assert.equal(events[0]?.type, 'context_usage');
  assert.equal(events.at(-1)?.type, 'final');
  assert.equal(events.filter((event) => event.type === 'context_usage').length, 1);
  assert.equal(events.filter((event) => event.type === 'final').length, 1);
  assert.equal(events.slice(1, -1).every((event) => event.type === 'token'), true);
  assert.equal(streamedText(events), 'the host is healthy');
  const final = events.at(-1);
  assert.ok(final && final.type === 'final');
  assert.equal(final.text, 'the host is healthy');
  assert.equal(final.provenance, undefined);

  assert.deepEqual(agent.getHistory().map(describe), [
    'user:how is the host',
    'assistant:the host is healthy',
  ]);
  // The prompt the runtime injected is not duplicated into the transcript.
  assert.equal(agent.getHistory().filter(isUser).length, 1);
});

test('event contract: two tool calls finishing out of order keep source order in history', async () => {
  const { fauxAssistantMessage, fauxText, fauxToolCall } = await loadPiAi();
  // "slow-first" takes longer than "fast-second", so completion order is inverted.
  const executor = new OrderedSshExecutor({ 'slow-first': 40, 'fast-second': 0 });
  const faux = await createFauxModelProvider({
    responses: [
      fauxAssistantMessage([
        fauxText('checking two things'),
        fauxToolCall('execute_ssh_command', { command: 'slow-first' }, { id: 'call-a' }),
        fauxToolCall('execute_ssh_command', { command: 'fast-second' }, { id: 'call-b' }),
      ]),
      fauxAssistantMessage('both commands are done'),
    ],
  });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    executor,
    undefined,
    { providerResolver: () => faux.provider },
  );

  const { events, reply } = collect(agent, 'run both');
  assert.equal(await reply, 'both commands are done');

  // Execution really did finish out of assistant order.
  assert.deepEqual(executor.started, ['slow-first', 'fast-second']);
  assert.deepEqual(executor.finished, ['fast-second', 'slow-first']);

  assert.equal(events[0]?.type, 'context_usage');
  assert.equal(events.at(-1)?.type, 'final');
  assert.equal(events.slice(1, -1).every((event) => event.type === 'token'), true);
  // Both assistant messages stream, concatenated in turn order and nothing lost.
  assert.equal(streamedText(events), 'checking two thingsboth commands are done');

  // Tool results are persisted in assistant source order regardless of timing,
  // which is what keeps `sanitizeToolCallHistory` from discarding the batch.
  assert.deepEqual(agent.getHistory().map(describe), [
    'user:run both',
    'assistant:checking two things[execute_ssh_command+execute_ssh_command]',
    'tool:execute_ssh_command:output of slow-first\n[exit_code=0]',
    'tool:execute_ssh_command:output of fast-second\n[exit_code=0]',
    'assistant:both commands are done',
  ]);
  const toolResults = agent.getHistory().filter(isToolResult);
  assert.deepEqual(toolResults.map((message) => message.toolCallId), ['call-a', 'call-b']);
  assert.equal(toolResults.every((message) => message.isError === false), true);

  // Second provider request saw both results.
  assert.equal(faux.requests.length, 2);
  assert.match(faux.requestText(1), /output of slow-first/);
  assert.match(faux.requestText(1), /output of fast-second/);
});

test('event contract: cancellation throws AgentCancelledError and leaves history clean', async () => {
  const { fauxAssistantMessage, fauxToolCall } = await loadPiAi();
  const executor = new OrderedSshExecutor({ 'sleep 1': 30 });
  const faux = await createFauxModelProvider({
    responses: [
      fauxAssistantMessage([fauxToolCall('execute_ssh_command', { command: 'sleep 1' }, { id: 'call-x' })]),
      fauxAssistantMessage('never reached'),
    ],
  });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    executor,
    undefined,
    { providerResolver: () => faux.provider },
  );
  agent.setHistory([
    { id: 'seed-user', role: 'user', text: 'earlier question', timestamp: 1 },
    { id: 'seed-assistant', role: 'assistant', text: 'earlier answer', toolCalls: [], timestamp: 2 },
  ]);

  const controller = new AbortController();
  const { events, reply } = collect(agent, 'start something long', controller.signal);
  // Abort once the first tool call is actually running.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  controller.abort();

  await assert.rejects(reply, (error: unknown) => error instanceof AgentCancelledError);

  // No `final` is emitted and nothing from the cancelled turn reaches history.
  assert.equal(events.some((event) => event.type === 'final'), false);
  assert.deepEqual(agent.getHistory().map(describe), [
    'user:earlier question',
    'assistant:earlier answer',
  ]);

  // The next turn still works on the same agent instance.
  faux.setResponses([fauxAssistantMessage('recovered')]);
  const second = collect(agent, 'try again');
  assert.equal(await second.reply, 'recovered');
  assert.deepEqual(agent.getHistory().map(describe), [
    'user:earlier question',
    'assistant:earlier answer',
    'user:try again',
    'assistant:recovered',
  ]);
});

test('event contract: a provider that never sends a text delta still emits one token event', async () => {
  const { createAssistantMessageEventStream, fauxAssistantMessage } = await loadPiAi();
  const message = fauxAssistantMessage('whole answer delivered at once');
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    new OrderedSshExecutor(),
    undefined,
    {
      // No `text_delta` is ever pushed, only the terminal `done` event.
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: 'stop', message });
        return stream;
      },
    },
  );

  const { events, reply } = collect(agent, 'answer without streaming');
  assert.equal(await reply, 'whole answer delivered at once');
  assert.equal(events.filter((event) => event.type === 'token').length, 1);
  assert.equal(streamedText(events), 'whole answer delivered at once');
  assert.deepEqual(agent.getHistory().map(describe), [
    'user:answer without streaming',
    'assistant:whole answer delivered at once',
  ]);
});

test('event contract: an oversized tool result is capped before the same turn re-enters the model', async () => {
  const { fauxAssistantMessage, fauxToolCall } = await loadPiAi();
  const huge = 'A'.repeat(9_000);
  const executor: SSHExecutor = {
    async execute(command) {
      return {
        command,
        stdout: huge,
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
      };
    },
    async write() {
      return true;
    },
  };
  const faux = await createFauxModelProvider({
    responses: [
      fauxAssistantMessage([fauxToolCall('execute_ssh_command', { command: 'cat big' }, { id: 'call-big' })]),
      fauxAssistantMessage('read the file'),
    ],
  });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    executor,
    undefined,
    { providerResolver: () => faux.provider },
  );

  assert.equal(await agent.chatStream('cat the big file', { terminalHistory: '' }), 'read the file');

  // Capping happens in `afterToolCall`, so the *second* request of this very turn
  // already sees the truncated result, not just later turns.
  assert.equal(faux.requests.length, 2);
  assert.match(faux.requestText(1), /\[truncated \d+ chars\]/);
  assert.equal(faux.requestText(1).includes(huge), false);

  const toolResult = agent.getHistory().find(isToolResult);
  assert.ok(toolResult);
  assert.match(toolResult.text, /\.\.\.\[truncated \d+ chars\]$/);
  assert.equal(toolResult.text.length < 2_100, true);
});

test('event contract: a provider failure returns localized text and never writes history', async () => {
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({
    responses: [fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: 'upstream refused the request',
    })],
  });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    new OrderedSshExecutor(),
    undefined,
    { providerResolver: () => faux.provider },
  );

  const { events, reply } = collect(agent, 'anything');
  assert.equal(await reply, 'AI 处理错误: upstream refused the request');
  assert.equal(events.some((event) => event.type === 'final'), false);
  assert.deepEqual(agent.getHistory(), []);

  const english = new SpotShellAgent(
    { apiKey: 'unused', language: 'en' },
    new OrderedSshExecutor(),
    undefined,
    { providerResolver: () => faux.provider },
  );
  faux.setResponses([fauxAssistantMessage('', {
    stopReason: 'error',
    errorMessage: 'upstream refused the request',
  })]);
  assert.equal(
    await english.chatStream('anything', { terminalHistory: '' }),
    'AI processing error: upstream refused the request',
  );
});
