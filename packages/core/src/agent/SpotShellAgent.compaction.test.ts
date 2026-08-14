import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { SpotShellAgent } from './SpotShellAgent.js';
import type { AgentStreamEvent, SSHExecutor } from './types.js';
import type { ModelProvider } from './providers/types.js';
import { ensureMessageIds } from '../context/ContextCompaction.js';

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

function longTurn(label: string): BaseMessage[] {
  return [
    new HumanMessage(`${label} user ${'x'.repeat(800)}`),
    new AIMessage(`${label} assistant ${'y'.repeat(800)}`),
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
  const model = new FakeListChatModel({ responses: ['live reply'] });
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
      model,
      summarizer: async () => 'SUMMARY_OF_OLD_TURNS',
    },
  );

  agent.setHistory(ensureMessageIds([
    ...longTurn('t1'),
    ...longTurn('t2'),
    ...longTurn('t3'),
    ...longTurn('recent-a'),
    ...longTurn('recent-b'),
  ]));

  const beforeIds = new Set(agent.getHistory().map((m) => m.id).filter(Boolean));
  const { reply, events } = await collectEvents(agent, 'continue the task');

  assert.equal(reply, 'live reply');
  const compaction = events.find((e) => e.type === 'context_compaction');
  assert.ok(compaction && compaction.type === 'context_compaction');
  assert.equal(compaction.summary.text, 'SUMMARY_OF_OLD_TURNS');
  assert.equal(compaction.summary.model, 'gpt-test-compact');
  assert.ok(compaction.summary.coveredMessageIds.length > 0);
  assert.ok(compaction.summary.coveredMessageIds.every((id) => beforeIds.has(id)));

  const historyText = agent.getHistory().map((m) => String(m.content)).join('\n');
  assert.doesNotMatch(historyText, /t1 user/);
  assert.match(historyText, /recent-b user|continue the task|live reply/);

  const usage = events.filter((e) => e.type === 'context_usage').at(-1);
  assert.ok(usage && usage.type === 'context_usage');
  const summarySlot = usage.usage.slots.find((slot) => slot.id === 'compactionSummary');
  assert.ok(summarySlot && summarySlot.estimatedTokens > 0);
  assert.ok(agent.getCompactionSummaries().length >= 1);
});

test('disabled auto compaction emits over-limit hint and keeps agent history', async () => {
  const model = new FakeListChatModel({ responses: ['reply without compact'] });
  const agent = new SpotShellAgent(
    {
      apiKey: 'unused',
      model: 'gpt-test',
      contextWindowTokens: 4_096,
      allowAutoContextCompaction: false,
    },
    new FakeSshExecutor(),
    undefined,
    { model },
  );

  const original = ensureMessageIds([
    ...longTurn('keep1'),
    ...longTurn('keep2'),
    ...longTurn('keep3'),
    ...longTurn('keep4'),
  ]);
  agent.setHistory(original);
  const originalCount = agent.getHistory().length;

  const { events } = await collectEvents(agent, 'one more');
  const over = events.find((e) => e.type === 'context_over_limit');
  assert.ok(over && over.type === 'context_over_limit');
  assert.equal(over.reason, 'auto_compact_disabled');
  assert.equal(agent.getCompactionSummaries().length, 0);
  // Original messages remain; only the new turn is appended.
  assert.ok(agent.getHistory().length >= originalCount);
  assert.ok(agent.getHistory().some((m) => String(m.content).includes('keep1 user')));
});

test('model switch uses the new model for compaction and preserves old summary metadata', async () => {
  const seenModelNames: string[] = [];
  const newModel = new FakeListChatModel({ responses: ['new-model reply'] });
  const anthropic: ModelProvider = {
    id: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    createChatModel: () => newModel,
    normalizeError: () => ({ kind: 'unknown', message: 'provider failed' }),
  };
  const openai: ModelProvider = {
    ...anthropic,
    id: 'openai',
    defaultModel: 'gpt-4o-mini',
  };
  const agent = new SpotShellAgent(
    { provider: 'openai', apiKey: 'old-key', model: 'gpt-old', contextWindowTokens: 4_096 },
    new FakeSshExecutor(),
    undefined,
    {
      model: new FakeListChatModel({ responses: [] }),
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
  agent.setHistory(ensureMessageIds([
    ...longTurn('switch-a'), ...longTurn('switch-b'), ...longTurn('switch-c'), ...longTurn('switch-d'),
  ]));

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
  const model = new FakeListChatModel({ responses: ['still works'] });
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
      model,
      summarizer: async () => {
        throw new Error('summarizer down');
      },
    },
  );

  const original = ensureMessageIds([
    ...longTurn('fail1'),
    ...longTurn('fail2'),
    ...longTurn('fail3'),
    ...longTurn('fail4'),
  ]);
  agent.setHistory(original);
  const snapshot = agent.getHistory().map((m) => String(m.content));

  const { events } = await collectEvents(agent, 'please continue');
  const failed = events.find((e) => e.type === 'context_compaction_failed');
  assert.ok(failed && failed.type === 'context_compaction_failed');
  assert.match(failed.error, /summarizer down/);
  for (const content of snapshot) {
    assert.ok(agent.getHistory().some((m) => String(m.content) === content));
  }
  assert.equal(agent.getCompactionSummaries().length, 0);
});

test('existing summaries are never used as input for a new summary', async () => {
  const seenInputs: string[] = [];
  const model = new FakeListChatModel({ responses: ['ok'] });
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
      model,
      summarizer: async ({ messages }) => {
        const joined = messages.map((m) => String(m.content)).join('\n');
        seenInputs.push(joined);
        return 'second-pass-summary';
      },
    },
  );

  agent.setHistory(ensureMessageIds([
    ...longTurn('a'),
    ...longTurn('b'),
    ...longTurn('c'),
    ...longTurn('d'),
  ]));
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

test('clearHistory drops compaction summaries with agent history', () => {
  const agent = new SpotShellAgent(
    { apiKey: 'unused', contextWindowTokens: 8_000 },
    new FakeSshExecutor(),
    undefined,
    { model: new FakeListChatModel({ responses: [] }) },
  );
  agent.setHistory([new HumanMessage('hi'), new AIMessage('yo')]);
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
