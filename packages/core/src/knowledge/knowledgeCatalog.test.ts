import assert from 'node:assert/strict';
import test from 'node:test';
import {
  queryKnowledgeCatalog,
  resolveKnowledgeCatalog,
  type PublishedEnvironmentSummary,
  type PublishedKnowledgeModuleSummary,
} from '../index.js';

function moduleSummary(
  id: string,
  name: string
): PublishedKnowledgeModuleSummary {
  return {
    id,
    name,
    description: `${name} reference`,
    whenToUse: `Use ${name}`,
    tags: [name.toLocaleLowerCase('en-US')],
    revision: 1,
    contentHash: `${name}-hash`,
  };
}

test('catalog fixes published environment always modules without candidate eligibility', () => {
  const fixed = moduleSummary('fixed', 'Fixed');
  const environmentCandidate = moduleSummary('environment', 'Environment');
  const sessionCandidate = moduleSummary('session', 'Session');
  const globalCandidate = moduleSummary('global', 'Global');
  const environment: PublishedEnvironmentSummary = {
    id: 'production',
    name: 'Production',
    description: 'Production environment',
    tags: [],
    always: [fixed.id],
    onDemand: [environmentCandidate.id, globalCandidate.id],
    revision: 1,
    contentHash: 'production-hash',
  };

  const catalog = resolveKnowledgeCatalog({
    availableModules: [globalCandidate, fixed, sessionCandidate, environmentCandidate],
    eligibleModules: [globalCandidate, sessionCandidate, environmentCandidate],
    environment,
    sessionAuthorizedIds: [sessionCandidate.id, fixed.id],
    globalAuthorizedIds: [globalCandidate.id, environmentCandidate.id],
  }, { catalogBudgetTokens: 10_000 });

  assert.deepEqual(catalog.fixed.map((entry) => entry.id), [fixed.id]);
  assert.equal(catalog.candidates.mode, 'inline');
  assert.deepEqual(catalog.candidates.entries.map((entry) => [entry.id, entry.scope]), [
    [environmentCandidate.id, 'environment'],
    [globalCandidate.id, 'environment'],
    [sessionCandidate.id, 'session'],
  ]);
});

test('catalog with metadata over budget does not inline any candidate entries', () => {
  const candidate = moduleSummary('large', 'A large candidate');

  const catalog = resolveKnowledgeCatalog({
    eligibleModules: [candidate],
    globalAuthorizedIds: [candidate.id],
  }, { catalogBudgetTokens: 1 });

  assert.deepEqual(catalog.candidates, {
    mode: 'query',
    total: 1,
    entries: [],
  });
});

test('large catalog query filters metadata and paginates in stable scope order', () => {
  const environmentCandidate = moduleSummary('environment-linux', 'Linux networking');
  const sessionCandidate = moduleSummary('session-linux', 'Linux storage');
  const unrelated = moduleSummary('global-windows', 'Windows services');
  const sources = {
    eligibleModules: [unrelated, sessionCandidate, environmentCandidate],
    environment: {
      id: 'production',
      name: 'Production',
      description: 'Production environment',
      tags: [],
      always: [],
      onDemand: [environmentCandidate.id],
      revision: 1,
      contentHash: 'production-hash',
    },
    sessionAuthorizedIds: [sessionCandidate.id],
    globalAuthorizedIds: [unrelated.id],
  } satisfies Parameters<typeof queryKnowledgeCatalog>[0];

  const firstPage = queryKnowledgeCatalog(sources, {
    query: 'linux',
    limit: 1,
    resultBudgetTokens: 10_000,
  });
  assert.deepEqual(firstPage.entries.map((entry) => entry.id), [environmentCandidate.id]);
  assert.ok(firstPage.nextCursor);

  const secondPage = queryKnowledgeCatalog(sources, {
    query: 'linux',
    cursor: firstPage.nextCursor,
    limit: 1,
    resultBudgetTokens: 10_000,
  });
  assert.deepEqual(secondPage.entries.map((entry) => entry.id), [sessionCandidate.id]);
  assert.equal(secondPage.nextCursor, undefined);
  assert.throws(() => queryKnowledgeCatalog(sources, {
    query: 'windows',
    cursor: firstPage.nextCursor,
    limit: 1,
    resultBudgetTokens: 10_000,
  }), /Invalid catalog query cursor/);
});

test('catalog query validates limits, budgets, and stale cursors', () => {
  const first = moduleSummary('first', 'First');
  const second = moduleSummary('second', 'Second');
  const sources = {
    eligibleModules: [first, second],
    globalAuthorizedIds: [first.id, second.id],
  };
  assert.throws(() => queryKnowledgeCatalog(sources, {
    limit: 0,
    resultBudgetTokens: 1_000,
  }), /limit must be between 1 and 100/);
  assert.throws(() => queryKnowledgeCatalog(sources, {
    limit: 1,
    resultBudgetTokens: 0,
  }), /result budget must be a positive integer/);
  assert.throws(() => queryKnowledgeCatalog(sources, {
    limit: 1,
    resultBudgetTokens: 1,
  }), /too small for one entry/);

  const page = queryKnowledgeCatalog(sources, {
    limit: 1,
    resultBudgetTokens: 1_000,
  });
  assert.ok(page.nextCursor);
  assert.throws(() => queryKnowledgeCatalog({
    eligibleModules: [],
    globalAuthorizedIds: [],
  }, {
    cursor: page.nextCursor,
    limit: 1,
    resultBudgetTokens: 1_000,
  }), /cursor is out of range/);
});
