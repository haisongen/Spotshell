import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assistantMessage,
  isSystem,
  systemMessage,
  toolResultMessage,
  userMessage,
  type AgentMessage,
} from '../agent/message.js';
import {
  COMPACTION_SUMMARY_BUDGET_RATIO,
  COMPACTION_TRIGGER_RATIO,
  estimateMessagesTokens,
  formatCompactionSummariesForContext,
  planContextCompaction,
  remainingSummaryBudgetTokens,
  type CompactionSummaryRecord,
} from './ContextCompaction.js';

function turn(user: string, assistant: string): AgentMessage[] {
  return [userMessage(user), assistantMessage(assistant)];
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
    const history = [
      ...turn('old question', 'old answer'),
      ...turn('recent question', 'recent answer'),
    ];
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
    const history = [
      ...turn('x'.repeat(400), 'y'.repeat(400)),
      ...turn('recent', 'answer'),
    ];
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
    const history: AgentMessage[] = [
      userMessage('turn1 user'),
      assistantMessage('', [
        { id: 'c1', name: 'execute_ssh_command', arguments: { command: 'uname' } },
      ]),
      toolResultMessage({ toolCallId: 'c1', toolName: 'execute_ssh_command', text: 'Linux host' }),
      assistantMessage('turn1 done'),
      userMessage('turn2 user'),
      assistantMessage('turn2 answer'),
      userMessage('recent user'),
      assistantMessage('recent answer'),
    ];
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
    const compactedText = plan.toCompact.map((m) => m.text).join('\n');
    // With a 2-turn recent tail, only the oldest turn (including completed tool output) is compacted.
    assert.match(compactedText, /turn1 user/);
    assert.match(compactedText, /Linux host/);
    assert.doesNotMatch(compactedText, /turn2 user/);
    assert.doesNotMatch(compactedText, /recent user/);
    assert.equal(plan.retain.at(-2)?.text, 'recent user');
    assert.equal(plan.retain.at(-1)?.text, 'recent answer');
    assert.ok(plan.retain.some((m) => m.text === 'turn2 user'));
  });

  it('never includes system messages in compaction input', () => {
    const history: AgentMessage[] = [
      systemMessage('safety rules must not be compacted'),
      ...turn('oldest', 'oldest answer'),
      ...turn('old', 'old answer'),
      ...turn('recent', 'recent answer'),
    ];
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
    assert.ok(plan.toCompact.every((m) => !isSystem(m)));
    assert.ok(plan.toCompact.every((m) => !m.text.includes('safety rules')));
    // Ineligible system messages stay in the retain set rather than being dropped.
    assert.ok(plan.retain.some(isSystem));
  });

  it('keeps independent summaries out of both toCompact and retain', () => {
    // Summaries live in the agent's own array, never as history messages, so a
    // planned split must not reintroduce their text on either side.
    const priorSummary = summary({
      id: 's1',
      text: 'PRIOR_SUMMARY_BODY',
      estimatedTokens: 5,
    });
    const history: AgentMessage[] = [
      ...turn('oldest', 'oldest answer'),
      ...turn('old', 'old answer'),
      ...turn('recent', 'recent answer'),
    ];
    const plan = planContextCompaction({
      allowAutoCompaction: true,
      usedInputTokens: 9_000,
      availableInputBudget: 10_000,
      chatBudgetTokens: 10,
      existingSummaries: [priorSummary],
      history,
    });
    assert.equal(plan.action, 'compact');
    if (plan.action !== 'compact') return;
    assert.ok(plan.toCompact.every((m) => !m.text.includes('PRIOR_SUMMARY_BODY')));
    assert.ok(plan.retain.every((m) => !m.text.includes('PRIOR_SUMMARY_BODY')));
    assert.equal(plan.toCompact.length + plan.retain.length, history.length);
    // The summary reaches the model only through the assembled context block.
    assert.match(
      formatCompactionSummariesForContext([priorSummary]) ?? '',
      /PRIOR_SUMMARY_BODY/,
    );
  });

  it('requires a new context when independent summary budget is exhausted', () => {
    const history = [
      ...turn('old '.repeat(200), 'ans '.repeat(200)),
      ...turn('recent', 'answer'),
    ];
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

describe('message ids and estimateMessagesTokens', () => {
  it('ids come with the message and stay stable under trimming', () => {
    const messages = [userMessage('abcd'), assistantMessage('efgh')];
    assert.ok(messages[0]?.id);
    assert.ok(messages[1]?.id);
    assert.notEqual(messages[0]?.id, messages[1]?.id);
    // Dropping the head must not change the surviving message's id.
    assert.equal(messages.slice(1)[0]?.id, messages[1]?.id);
    assert.ok(estimateMessagesTokens(messages) >= 2);
  });
});
