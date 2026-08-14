import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  COMPACTION_SUMMARY_BUDGET_RATIO,
  COMPACTION_TRIGGER_RATIO,
  ensureMessageIds,
  estimateMessagesTokens,
  planContextCompaction,
  remainingSummaryBudgetTokens,
  type CompactionSummaryRecord,
} from './ContextCompaction.js';

function turn(user: string, assistant: string) {
  return [new HumanMessage(user), new AIMessage(assistant)];
}

function summary(partial: Partial<CompactionSummaryRecord> & Pick<CompactionSummaryRecord, 'id' | 'text'>): CompactionSummaryRecord {
  return {
    coveredMessageIds: partial.coveredMessageIds ?? ['a'],
    coveredFromPreview: partial.coveredFromPreview ?? 'from',
    coveredToPreview: partial.coveredToPreview ?? 'to',
    model: partial.model ?? 'gpt-test',
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    estimatedTokens: partial.estimatedTokens ?? 10,
    ...partial,
  };
}

describe('planContextCompaction', () => {
  it('does nothing when usage is under the trigger ratio', () => {
    const history = ensureMessageIds([
      ...turn('old question', 'old answer'),
      ...turn('recent question', 'recent answer'),
    ]);
    const plan = planContextCompaction({
      allowAutoCompaction: true,
      usedInputTokens: 1_000,
      availableInputBudget: 10_000,
      chatBudgetTokens: 4_000,
      history,
      existingSummaries: [],
    });
    assert.equal(plan.action, 'none');
  });

  it('hints over-limit without deleting history when auto compaction is disabled', () => {
    const history = ensureMessageIds([
      ...turn('x'.repeat(400), 'y'.repeat(400)),
      ...turn('recent', 'answer'),
    ]);
    const plan = planContextCompaction({
      allowAutoCompaction: false,
      usedInputTokens: Math.ceil(10_000 * COMPACTION_TRIGGER_RATIO),
      availableInputBudget: 10_000,
      chatBudgetTokens: 100,
      history,
      existingSummaries: [],
    });
    assert.equal(plan.action, 'hint_over_limit');
    if (plan.action !== 'hint_over_limit') return;
    assert.equal(plan.reason, 'auto_compact_disabled');
  });

  it('selects only older chat and completed tool outputs, retaining a recent verbatim tail', () => {
    const history = ensureMessageIds([
      new HumanMessage('turn1 user'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'execute_ssh_command', args: { command: 'uname' }, type: 'tool_call' }],
      }),
      new ToolMessage({ tool_call_id: 'c1', content: 'Linux host' }),
      new AIMessage('turn1 done'),
      new HumanMessage('turn2 user'),
      new AIMessage('turn2 answer'),
      new HumanMessage('recent user'),
      new AIMessage('recent answer'),
    ]);
    const plan = planContextCompaction({
      allowAutoCompaction: true,
      usedInputTokens: 9_000,
      availableInputBudget: 10_000,
      chatBudgetTokens: 50,
      history,
      existingSummaries: [],
    });
    assert.equal(plan.action, 'compact');
    if (plan.action !== 'compact') return;
    const compactedText = plan.toCompact.map((m) => String(m.content)).join('\n');
    // With a 2-turn recent tail, only the oldest turn (including completed tool output) is compacted.
    assert.match(compactedText, /turn1 user/);
    assert.match(compactedText, /Linux host/);
    assert.doesNotMatch(compactedText, /turn2 user/);
    assert.doesNotMatch(compactedText, /recent user/);
    assert.equal(String(plan.retain.at(-2)?.content), 'recent user');
    assert.equal(String(plan.retain.at(-1)?.content), 'recent answer');
    assert.ok(plan.retain.some((m) => String(m.content) === 'turn2 user'));
  });

  it('never includes system messages or prior summaries in compaction input', () => {
    const history = ensureMessageIds([
      new SystemMessage('safety rules must not be compacted'),
      new HumanMessage('oldest'),
      new AIMessage('oldest answer'),
      new HumanMessage('old'),
      new AIMessage('old answer'),
      new HumanMessage('recent'),
      new AIMessage('recent answer'),
    ]);
    const plan = planContextCompaction({
      allowAutoCompaction: true,
      usedInputTokens: 9_000,
      availableInputBudget: 10_000,
      chatBudgetTokens: 10,
      existingSummaries: [summary({ id: 's1', text: 'prior summary body', estimatedTokens: 5 })],
      history,
    });
    assert.equal(plan.action, 'compact');
    if (plan.action !== 'compact') return;
    assert.ok(plan.toCompact.every((m) => !SystemMessage.isInstance(m)));
    assert.ok(plan.toCompact.every((m) => !String(m.content).includes('prior summary')));
    assert.ok(plan.toCompact.every((m) => !String(m.content).includes('safety rules')));
    // Ineligible system messages stay in the retain set rather than being dropped.
    assert.ok(plan.retain.some((m) => SystemMessage.isInstance(m)));
  });

  it('requires a new context when independent summary budget is exhausted', () => {
    const history = ensureMessageIds([
      ...turn('old '.repeat(200), 'ans '.repeat(200)),
      ...turn('recent', 'answer'),
    ]);
    const available = 10_000;
    const budget = Math.floor(available * COMPACTION_SUMMARY_BUDGET_RATIO);
    const plan = planContextCompaction({
      allowAutoCompaction: true,
      usedInputTokens: 9_000,
      availableInputBudget: available,
      chatBudgetTokens: 10,
      history,
      existingSummaries: [
        summary({ id: 's1', text: 'x'.repeat(budget * 4), estimatedTokens: budget }),
      ],
    });
    assert.equal(plan.action, 'hint_over_limit');
    if (plan.action !== 'hint_over_limit') return;
    assert.equal(plan.reason, 'summary_budget_exhausted');
  });

  it('shares remaining summary budget across independent summaries', () => {
    const available = 10_000;
    const totalBudget = Math.floor(available * COMPACTION_SUMMARY_BUDGET_RATIO);
    const used = Math.floor(totalBudget / 2);
    assert.equal(
      remainingSummaryBudgetTokens(available, [
        summary({ id: 's1', text: 'half', estimatedTokens: used }),
      ]),
      totalBudget - used,
    );
  });
});

describe('ensureMessageIds / estimateMessagesTokens', () => {
  it('assigns stable ids once and estimates total tokens', () => {
    const messages = ensureMessageIds([new HumanMessage('abcd'), new AIMessage('efgh')]);
    assert.ok(messages[0]?.id);
    assert.ok(messages[1]?.id);
    assert.notEqual(messages[0]?.id, messages[1]?.id);
    const again = ensureMessageIds(messages);
    assert.equal(again[0]?.id, messages[0]?.id);
    assert.ok(estimateMessagesTokens(messages) >= 2);
  });
});
