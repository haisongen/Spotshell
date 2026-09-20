import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotShellAgent } from './SpotShellAgent.js';
import type { AgentStreamEvent, SSHExecutor } from './types.js';
import type { ModelProvider } from './providers/types.js';
import { assistantMessage, userMessage, type AgentMessage } from './message.js';
import { createFauxModelProvider, loadPiAi } from '../testing/fauxModelProvider.js';

class FakeSshExecutor implements SSHExecutor {
  async execute(command: string) {
    return {
      command,
      stdout: '',
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

function longTurn(label: string): AgentMessage[] {
  return [
    userMessage(`${label} user ${'x'.repeat(800)}`),
    assistantMessage(`${label} assistant ${'y'.repeat(800)}`),
  ];
}

function collectEvents(agent: SpotShellAgent, userInput: string): Promise<{
  reply: string;
  events: AgentStreamEvent[];
}> {
  const events: AgentStreamEvent[] = [];
  return agent.chatStream(userInput, { terminalHistory: '' }, {
    onEvent: (event) => events.push(event),
  }).then((reply) => ({ reply, events }));
}

test('auto compaction replaces older agent history with one inspectable summary and meters it', async () => {
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({ responses: [fauxAssistantMessage('live reply')] });
  const agent = new SpotShellAgent(
    {
      apiKey: 'unused',
      model: 'gpt-test-compact',
      contextWindowTokens: 4_096,
      allowAutoContextCompaction: true,
    },
    new FakeSshExecutor(),
    undefined,
    {
      providerResolver: () => faux.provider,
      summarizer: async () => 'SUMMARY_OF_OLD_TURNS',
    },
  );

  agent.setHistory([
    ...longTurn('t1'),
    ...longTurn('t2'),
    ...longTurn('t3'),
    ...longTurn('recent-a'),
    ...longTurn('recent-b'),
  ]);

  const beforeIds = new Set(agent.getHistory().map((m) => m.id).filter(Boolean));
  const { reply, events } = await collectEvents(agent, 'continue the task');

  assert.equal(reply, 'live reply');
  const compaction = events.find((e) => e.type === 'context_compaction');
  assert.ok(compaction && compaction.type === 'context_compaction');
  assert.equal(compaction.summary.text, 'SUMMARY_OF_OLD_TURNS');
  assert.equal(compaction.summary.model, 'gpt-test-compact');
  assert.ok(compaction.summary.coveredMessageIds.length > 0);
  assert.ok(compaction.summary.coveredMessageIds.every((id) => beforeIds.has(id)));

  const historyText = agent.getHistory().map((m) => m.text).join('\n');
  assert.doesNotMatch(historyText, /t1 user/);
  assert.match(historyText, /recent-b user|continue the task|live reply/);

  const usage = events.filter((e) => e.type === 'context_usage').at(-1);
  assert.ok(usage && usage.type === 'context_usage');
  const summarySlot = usage.usage.slots.find((slot) => slot.id === 'compactionSummary');
  assert.ok(summarySlot && summarySlot.estimatedTokens > 0);
  assert.ok(agent.getCompactionSummaries().length >= 1);
});

test('disabled auto compaction emits over-limit hint and keeps agent history', async () => {
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({
    responses: [fauxAssistantMessage('reply without compact')],
  });
  const agent = new SpotShellAgent(
    {
      apiKey: 'unused',
      model: 'gpt-test',
      contextWindowTokens: 4_096,
      allowAutoContextCompaction: false,
    },
    new FakeSshExecutor(),
    undefined,
    { providerResolver: () => faux.provider },
  );

  const original = [
    ...longTurn('keep1'),
    ...longTurn('keep2'),
    ...longTurn('keep3'),
    ...longTurn('keep4'),
  ];
  agent.setHistory(original);
  const originalCount = agent.getHistory().length;

  const { events } = await collectEvents(agent, 'one more');
  const over = events.find((e) => e.type === 'context_over_limit');
  assert.ok(over && over.type === 'context_over_limit');
  assert.equal(over.reason, 'auto_compact_disabled');
  assert.equal(agent.getCompactionSummaries().length, 0);
  // Original messages remain; only the new turn is appended.
  assert.ok(agent.getHistory().length >= originalCount);
  assert.ok(agent.getHistory().some((m) => m.text.includes('keep1 user')));
});

test('model switch uses the new model for compaction and preserves old summary metadata', async () => {
  const seenModelNames: string[] = [];
  const { fauxAssistantMessage } = await loadPiAi();
  const newFaux = await createFauxModelProvider({
    id: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    responses: [fauxAssistantMessage('new-model reply')],
  });
  const anthropic: ModelProvider = newFaux.provider;
  const openai: ModelProvider = { ...anthropic, id: 'openai', defaultModel: 'gpt-4o-mini' };
  const agent = new SpotShellAgent(
    { provider: 'openai', apiKey: 'old-key', model: 'gpt-old', contextWindowTokens: 4_096 },
    new FakeSshExecutor(),
    undefined,
    {
      providerResolver: (id) => id === 'anthropic' ? anthropic : openai,
      summarizer: async ({ modelName }) => {
        seenModelNames.push(modelName);
        return 'summary from new model';
      },
    },
  );
  agent.replaceCompactionSummariesForTest([{
    id: 'old-summary', text: 'old summary', coveredMessageIds: ['old-message'],
    coveredFromPreview: 'old', coveredToPreview: 'old', model: 'gpt-old',
    createdAt: '2026-01-01T00:00:00.000Z', estimatedTokens: 4,
  }]);
  agent.setHistory([
    ...longTurn('switch-a'), ...longTurn('switch-b'), ...longTurn('switch-c'), ...longTurn('switch-d'),
  ]);

  agent.updateModel({
    provider: 'anthropic', apiKey: 'new-key', model: 'claude-new', contextWindowTokens: 4_096,
  });
  await collectEvents(agent, 'continue after switch');

  assert.deepEqual(seenModelNames, ['claude-new']);
  const summaries = agent.getCompactionSummaries();
  assert.equal(summaries[0]?.model, 'gpt-old');
  assert.equal(summaries[1]?.model, 'claude-new');
});

test('failed summary generation leaves agent history unchanged and emits failure', async () => {
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({ responses: [fauxAssistantMessage('still works')] });
  const agent = new SpotShellAgent(
    {
      apiKey: 'unused',
      model: 'gpt-test',
      contextWindowTokens: 4_096,
      allowAutoContextCompaction: true,
    },
    new FakeSshExecutor(),
    undefined,
    {
      providerResolver: () => faux.provider,
      summarizer: async () => {
        throw new Error('summarizer down');
      },
    },
  );

  const original = [
    ...longTurn('fail1'),
    ...longTurn('fail2'),
    ...longTurn('fail3'),
    ...longTurn('fail4'),
  ];
  agent.setHistory(original);
  const snapshot = agent.getHistory().map((m) => m.text);

  const { events } = await collectEvents(agent, 'please continue');
  const failed = events.find((e) => e.type === 'context_compaction_failed');
  assert.ok(failed && failed.type === 'context_compaction_failed');
  assert.match(failed.error, /summarizer down/);
  for (const content of snapshot) {
    assert.ok(agent.getHistory().some((m) => m.text === content));
  }
  assert.equal(agent.getCompactionSummaries().length, 0);
});

test('existing summaries are never used as input for a new summary', async () => {
  const seenInputs: string[] = [];
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({ responses: [fauxAssistantMessage('ok')] });
  const agent = new SpotShellAgent(
    {
      apiKey: 'unused',
      model: 'gpt-test',
      contextWindowTokens: 4_096,
      allowAutoContextCompaction: true,
    },
    new FakeSshExecutor(),
    undefined,
    {
      providerResolver: () => faux.provider,
      summarizer: async ({ messages }) => {
        const joined = messages.map((m) => m.text).join('\n');
        seenInputs.push(joined);
        return 'second-pass-summary';
      },
    },
  );

  agent.setHistory([
    ...longTurn('a'),
    ...longTurn('b'),
    ...longTurn('c'),
    ...longTurn('d'),
  ]);
  // Seed an independent prior summary that must not be re-fed.
  agent.replaceCompactionSummariesForTest([{
    id: 'seed',
    text: 'SEED_SUMMARY_MUST_NOT_REENTER',
    coveredMessageIds: ['gone-1'],
    coveredFromPreview: 'gone',
    coveredToPreview: 'gone',
    model: 'gpt-test',
    createdAt: '2026-01-01T00:00:00.000Z',
    estimatedTokens: 20,
  }]);

  await collectEvents(agent, 'next');
  assert.ok(seenInputs.length >= 1);
  for (const input of seenInputs) {
    assert.doesNotMatch(input, /SEED_SUMMARY_MUST_NOT_REENTER/);
  }
});

test('clearHistory drops compaction summaries with agent history', async () => {
  const faux = await createFauxModelProvider({});
  const agent = new SpotShellAgent(
    { apiKey: 'unused', contextWindowTokens: 8_000 },
    new FakeSshExecutor(),
    undefined,
    { providerResolver: () => faux.provider },
  );
  agent.setHistory([userMessage('hi'), assistantMessage('yo')]);
  agent.replaceCompactionSummariesForTest([{
    id: 's',
    text: 'sum',
    coveredMessageIds: ['x'],
    coveredFromPreview: 'x',
    coveredToPreview: 'x',
    model: 'm',
    createdAt: '2026-01-01T00:00:00.000Z',
    estimatedTokens: 1,
  }]);
  agent.clearHistory();
  assert.deepEqual(agent.getHistory(), []);
  assert.deepEqual(agent.getCompactionSummaries(), []);
});

test('the built-in summarizer sends a tool-free one-shot request and returns its text', async () => {
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({
    responses: [
      // First request is the summarization; the live turn answers second.
      fauxAssistantMessage('BUILT_IN_SUMMARY'),
      fauxAssistantMessage('reply after built-in compaction'),
    ],
  });
  const agent = new SpotShellAgent(
    {
      apiKey: 'unused',
      model: 'gpt-test-builtin',
      contextWindowTokens: 4_096,
      allowAutoContextCompaction: true,
    },
    new FakeSshExecutor(),
    undefined,
    { providerResolver: () => faux.provider },
  );
  agent.setHistory([
    ...longTurn('b1'),
    ...longTurn('b2'),
    ...longTurn('b3'),
    ...longTurn('b4'),
  ]);

  const { reply, events } = await collectEvents(agent, 'continue');

  assert.equal(reply, 'reply after built-in compaction');
  const compaction = events.find((e) => e.type === 'context_compaction');
  assert.ok(compaction && compaction.type === 'context_compaction');
  assert.equal(compaction.summary.text, 'BUILT_IN_SUMMARY');
  assert.equal(compaction.summary.model, 'gpt-test-builtin');

  // The summarization request carries no tools and exactly one user message.
  assert.equal(faux.requests.length, 2);
  assert.deepEqual(faux.requests[0]?.toolNames, []);
  assert.equal(faux.requests[0]?.messages.length, 1);
  assert.match(faux.requests[0]?.systemPrompt ?? '', /压缩为连续摘要/);
  assert.match(faux.requestText(0), /b1 user/);
  // The live turn that follows does carry the SSH tools.
  assert.ok((faux.requests[1]?.toolNames ?? []).includes('execute_ssh_command'));
});

test('a failing built-in summarization is reported and leaves history untouched', async () => {
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({
    responses: [
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary endpoint down' }),
      fauxAssistantMessage('reply despite failed compaction'),
    ],
  });
  const agent = new SpotShellAgent(
    {
      apiKey: 'unused',
      model: 'gpt-test-builtin-fail',
      contextWindowTokens: 4_096,
      allowAutoContextCompaction: true,
    },
    new FakeSshExecutor(),
    undefined,
    { providerResolver: () => faux.provider },
  );
  agent.setHistory([...longTurn('f1'), ...longTurn('f2'), ...longTurn('f3'), ...longTurn('f4')]);

  const { reply, events } = await collectEvents(agent, 'continue anyway');

  assert.equal(reply, 'reply despite failed compaction');
  const failed = events.find((e) => e.type === 'context_compaction_failed');
  assert.ok(failed && failed.type === 'context_compaction_failed');
  assert.match(failed.error, /summary endpoint down/);
  assert.equal(agent.getCompactionSummaries().length, 0);
  assert.ok(agent.getHistory().some((m) => m.text.includes('f1 user')));
});
