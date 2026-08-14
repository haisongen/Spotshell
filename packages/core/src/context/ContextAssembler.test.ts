import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleModelContext,
  estimateTextTokens,
  type ContextAssemblerInput,
  type GuidanceRule,
} from './ContextAssembler.js';

function rule(
  id: string,
  text: string,
  sourceLayer: GuidanceRule['sourceLayer'],
  order = 0,
): GuidanceRule {
  return {
    id,
    text,
    sourceLayer,
    order,
    moduleId: `mod-${sourceLayer}`,
    moduleName: `Module ${sourceLayer}`,
    revision: 1,
    relativePath: 'SPACE.md',
  };
}

function baseInput(overrides: Partial<ContextAssemblerInput> = {}): ContextAssemblerInput {
  return {
    contextWindowTokens: 8_000,
    system: 'system safety rules',
    tools: 'tool definitions',
    currentRequest: 'please inspect memory',
    ...overrides,
  };
}

describe('ContextAssembler', () => {
  it('reserves output and estimation safety space before allocating input', () => {
    const result = assembleModelContext(baseInput({ contextWindowTokens: 10_000 }));
    assert.ok(result.outputReserveTokens > 0);
    assert.ok(result.safetyReserveTokens > 0);
    assert.equal(
      result.availableInputBudget,
      10_000 - result.outputReserveTokens - result.safetyReserveTokens,
    );
    assert.ok(result.availableInputBudget < 10_000);
    assert.equal(result.estimated, true);
  });

  it('never lets knowledge slots squeeze out system, tools, request, or approval state', () => {
    const hugeGuidance = rule('g1', 'x'.repeat(40_000), 'sessionPinned');
    const result = assembleModelContext(baseInput({
      contextWindowTokens: 8_000,
      system: 'safety-critical',
      tools: 'tool-defs',
      currentRequest: 'current-user-request',
      approvalState: 'pending approval for rm -rf /',
      guidance: [hugeGuidance],
      reference: 'y'.repeat(40_000),
      catalog: 'z'.repeat(40_000),
    }));

    assert.match(result.assembled.system, /safety-critical/);
    assert.match(result.assembled.tools ?? '', /tool-defs/);
    assert.match(result.assembled.currentRequest, /current-user-request/);
    assert.match(result.assembled.approvalState ?? '', /pending approval/);
    assert.equal(result.includedGuidance.length, 0);
    assert.equal(result.omittedGuidance.map((item) => item.id).join(), 'g1');
    assert.equal(result.assembled.reference, undefined);
  });

  it('orders guidance by safety, user request, session pinned, environment always, then dynamic', () => {
    const result = assembleModelContext(baseInput({
      contextWindowTokens: 128_000,
      guidance: [
        rule('dyn', 'dynamic rule', 'dynamic', 0),
        rule('env', 'environment rule', 'environmentAlways', 0),
        rule('pin', 'pinned rule', 'sessionPinned', 0),
        rule('user', 'user rule', 'userRequest', 0),
        rule('safe', 'safety rule', 'safety', 0),
      ],
    }));

    assert.deepEqual(
      result.includedGuidance.map((item) => item.id),
      ['safe', 'user', 'pin', 'env', 'dyn'],
    );
  });

  it('keeps stable user-visible order within the same guidance layer', () => {
    const result = assembleModelContext(baseInput({
      contextWindowTokens: 128_000,
      guidance: [
        rule('b', 'second', 'sessionPinned', 2),
        rule('a', 'first', 'sessionPinned', 1),
        rule('c', 'third', 'sessionPinned', 3),
      ],
    }));
    assert.deepEqual(result.includedGuidance.map((item) => item.id), ['a', 'b', 'c']);
  });

  it('omits whole guidance rules when over budget without truncating or summarizing them', () => {
    const first = rule('keep', 'k'.repeat(200), 'sessionPinned', 0);
    const second = rule('drop', 'd'.repeat(20_000), 'sessionPinned', 1);
    const result = assembleModelContext(baseInput({
      contextWindowTokens: 4_096,
      guidance: [first, second],
    }));

    assert.equal(result.includedGuidance.length, 1);
    assert.equal(result.includedGuidance[0]?.id, 'keep');
    assert.equal(result.omittedGuidance[0]?.id, 'drop');
    assert.equal(result.omittedGuidance[0]?.text, second.text);
    assert.ok(!result.assembled.guidance?.includes('...'));
    assert.ok(!result.assembled.guidance?.toLocaleLowerCase('en-US').includes('summary'));
  });

  it('does not back-fill lower-priority guidance after a higher-priority rule is omitted', () => {
    const largePinned = rule('large-pin', 'p'.repeat(20_000), 'sessionPinned', 0);
    const smallDynamic = rule('small-dyn', 'tiny dynamic', 'dynamic', 0);
    const result = assembleModelContext(baseInput({
      contextWindowTokens: 4_096,
      guidance: [largePinned, smallDynamic],
    }));
    assert.equal(result.includedGuidance.length, 0);
    assert.deepEqual(result.omittedGuidance.map((item) => item.id), ['large-pin', 'small-dyn']);
  });

  it('reports obvious same-layer conflicts with both original texts and sources', () => {
    const result = assembleModelContext(baseInput({
      contextWindowTokens: 128_000,
      guidance: [
        {
          ...rule('a', 'Never restart nginx without approval.', 'sessionPinned', 0),
          moduleName: 'Nginx Ops',
          relativePath: 'rules/a.md',
        },
        {
          ...rule('b', 'Always restart nginx immediately on error.', 'sessionPinned', 1),
          moduleName: 'Nginx Ops',
          relativePath: 'rules/b.md',
        },
      ],
    }));

    assert.equal(result.conflicts.length, 1);
    const conflict = result.conflicts[0]!;
    assert.equal(conflict.left.id, 'a');
    assert.equal(conflict.right.id, 'b');
    assert.match(conflict.left.text, /Never restart nginx/);
    assert.match(conflict.right.text, /Always restart nginx/);
    assert.equal(conflict.left.moduleName, 'Nginx Ops');
    assert.equal(conflict.right.relativePath, 'rules/b.md');
  });

  it('includes explicit userQuotes from old context as a dedicated usage slot', () => {
    const quote = '[Quoted message 1]\nsource epoch 1\nrole: assistant\ncontent:\nprior analysis';
    const result = assembleModelContext(baseInput({
      contextWindowTokens: 128_000,
      userQuotes: quote,
      chat: 'current epoch chat only',
    }));
    assert.equal(result.assembled.userQuotes, quote);
    const slot = result.slots.find((item) => item.id === 'userQuotes');
    assert.ok(slot);
    assert.ok((slot?.estimatedTokens ?? 0) > 0);
    assert.ok(result.usedInputTokens >= estimateTextTokens(quote));
  });

  it('prioritizes userQuotes over lower soft slots when budget is tight', () => {
    const quote = 'quoted-evidence-'.repeat(40);
    const result = assembleModelContext(baseInput({
      contextWindowTokens: 2_500,
      system: 's',
      tools: 't',
      currentRequest: 'r',
      userQuotes: quote,
      catalog: 'c'.repeat(20_000),
      chat: 'chat history that may be trimmed',
    }));
    assert.ok(result.assembled.userQuotes);
    assert.match(result.assembled.userQuotes ?? '', /quoted-evidence/);
    assert.equal(result.assembled.catalog, undefined);
  });

  it('labels every slot as estimated when tokenizer is unknown', () => {
    const result = assembleModelContext(baseInput({
      environment: 'prod cluster',
      hostNotes: 'host notes',
      terminal: 'terminal output',
      chat: 'older chat',
      guidance: [rule('g', 'rule text', 'dynamic')],
      catalog: 'catalog entry',
      reference: 'reference body',
      userQuotes: 'quoted old message',
    }));

    assert.equal(result.estimated, true);
    for (const slot of result.slots) {
      assert.equal(slot.estimated, true);
      assert.ok(slot.estimatedTokens >= 0);
      assert.ok(slot.shareOfInputBudget >= 0);
    }
    const ids = result.slots.map((slot) => slot.id);
    for (const expected of [
      'system',
      'environment',
      'hostNotes',
      'guidance',
      'catalog',
      'reference',
      'userQuotes',
      'terminal',
      'chat',
    ] as const) {
      assert.ok(ids.includes(expected), `missing slot ${expected}`);
    }
  });

  it('recomputes over-budget and omission state when the model window changes', () => {
    const guidance = [
      rule('small', 's'.repeat(100), 'environmentAlways', 0),
      rule('large', 'l'.repeat(8_000), 'environmentAlways', 1),
    ];
    const narrow = assembleModelContext(baseInput({
      contextWindowTokens: 4_096,
      guidance,
    }));
    const wide = assembleModelContext(baseInput({
      contextWindowTokens: 128_000,
      guidance,
    }));

    assert.ok(narrow.omittedGuidance.some((item) => item.id === 'large'));
    assert.ok(wide.includedGuidance.some((item) => item.id === 'large'));
    assert.ok(wide.availableInputBudget > narrow.availableInputBudget);
  });

  it('preserves historical estimates when provider usage is attached later', () => {
    const result = assembleModelContext(baseInput());
    const withProvider = {
      ...result,
      providerUsage: { promptTokens: 999, completionTokens: 50, totalTokens: 1_049 },
    };
    assert.equal(withProvider.usedInputTokens, result.usedInputTokens);
    assert.equal(withProvider.estimated, true);
    assert.notEqual(withProvider.usedInputTokens, withProvider.providerUsage?.promptTokens);
  });

  it('estimateTextTokens uses chars/4 ceiling', () => {
    assert.equal(estimateTextTokens('a'.repeat(400)), 100);
    assert.equal(estimateTextTokens(''), 0);
  });
});
