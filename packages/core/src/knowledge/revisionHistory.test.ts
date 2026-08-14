import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotateRevisionHistoryEntry,
  assertCleanupAllowed,
  assertEnoughDiskSpace,
  buildRevisionComparison,
  compareRevisionFiles,
  exclusiveBytesForRevision,
  isRevisionProtected,
  planRevisionCleanup,
  protectionReasonsForRevision,
  restoreOrigin,
} from './revisionHistory.js';

test('current effective, agent-active, proposal and recovery pins protect a revision', () => {
  const protection = {
    latestRevision: 5,
    agentActiveRevisions: [3, 4],
    proposalTargetRevisions: [2],
    recoveryRequiredRevisions: [1],
  };

  assert.deepEqual(protectionReasonsForRevision(5, protection), ['current-effective']);
  assert.deepEqual(protectionReasonsForRevision(3, protection), ['agent-active']);
  assert.deepEqual(protectionReasonsForRevision(2, protection), ['proposal-target']);
  assert.deepEqual(protectionReasonsForRevision(1, protection), ['recovery-required']);
  assert.deepEqual(protectionReasonsForRevision(6, protection), []);
  assert.equal(isRevisionProtected(5, protection), true);
  assert.equal(isRevisionProtected(6, protection), false);
});

test('history entries surface effective and agent-active markers', () => {
  const entry = annotateRevisionHistoryEntry({
    id: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-05T00:00:00.000Z',
    origin: restoreOrigin(1),
    sizeBytes: 120,
    exclusiveBytes: 40,
    protection: {
      latestRevision: 3,
      agentActiveRevisions: [2],
    },
  });

  assert.equal(entry.isCurrentEffective, false);
  assert.equal(entry.isAgentActive, true);
  assert.equal(entry.origin, 'restore:1');
  assert.deepEqual(entry.protectionReasons, ['agent-active']);
});

test('compareRevisionFiles reports entry and object file differences', () => {
  const left = [
    { relativePath: 'SPACE.md', content: 'a', sizeBytes: 1, contentHash: 'h1' },
    { relativePath: 'notes.md', content: 'old', sizeBytes: 3, contentHash: 'n1' },
    { relativePath: 'gone.txt', content: 'x', sizeBytes: 1, contentHash: 'g1' },
  ];
  const right = [
    { relativePath: 'SPACE.md', content: 'b', sizeBytes: 1, contentHash: 'h2' },
    { relativePath: 'notes.md', content: 'old', sizeBytes: 3, contentHash: 'n1' },
    { relativePath: 'new.txt', content: 'y', sizeBytes: 1, contentHash: 'y1' },
  ];

  const diffs = compareRevisionFiles(left, right);
  const byPath = new Map(diffs.map((diff) => [diff.relativePath, diff.change]));
  assert.equal(byPath.get('SPACE.md'), 'modified');
  assert.equal(byPath.get('gone.txt'), 'removed');
  assert.equal(byPath.get('new.txt'), 'added');
  assert.equal(byPath.get('notes.md'), 'unchanged');
  assert.equal(diffs.length, 4);

  const comparison = buildRevisionComparison({
    objectId: '11111111-1111-4111-8111-111111111111',
    leftRevision: 1,
    rightRevision: 2,
    leftContentHash: 'c1',
    rightContentHash: 'c2',
    leftFiles: left,
    rightFiles: right,
  });
  assert.equal(comparison.entryChanged, true);
});

test('cleanup preview blocks protected revisions and estimates exclusive free space', () => {
  const preview = planRevisionCleanup({
    objectId: '11111111-1111-4111-8111-111111111111',
    requestedRevisions: [1, 2, 3, 9],
    availableRevisions: [1, 2, 3, 4],
    protection: {
      latestRevision: 4,
      agentActiveRevisions: [3],
    },
    blobReferences: [
      { contentHash: 'shared', sizeBytes: 100, revisions: [1, 2] },
      { contentHash: 'only1', sizeBytes: 40, revisions: [1] },
      { contentHash: 'only2', sizeBytes: 25, revisions: [2] },
      { contentHash: 'active3', sizeBytes: 10, revisions: [3] },
    ],
  });

  assert.deepEqual(preview.requestedRevisions, [1, 2, 3]);
  assert.deepEqual(preview.removableRevisions, [1, 2]);
  assert.deepEqual(preview.blockedRevisions, [{
    revision: 3,
    reasons: ['agent-active'],
  }]);
  // shared blob stays (referenced by both removable — wait, if both 1 and 2 removed, shared becomes free too)
  assert.equal(preview.estimatedFreedBytes, 100 + 40 + 25);
  assert.equal(preview.irreversible, true);
  assert.equal(exclusiveBytesForRevision(1, [
    { contentHash: 'shared', sizeBytes: 100, revisions: [1, 2] },
    { contentHash: 'only1', sizeBytes: 40, revisions: [1] },
  ]), 40);
});

test('assertCleanupAllowed rejects protected or empty selections', () => {
  assert.throws(
    () => assertCleanupAllowed({
      objectId: 'x',
      requestedRevisions: [1],
      removableRevisions: [],
      blockedRevisions: [{ revision: 1, reasons: ['current-effective'] }],
      estimatedFreedBytes: 0,
      irreversible: true,
    }),
    /protected revisions/,
  );

  assert.throws(
    () => assertCleanupAllowed({
      objectId: 'x',
      requestedRevisions: [],
      removableRevisions: [],
      blockedRevisions: [],
      estimatedFreedBytes: 0,
      irreversible: true,
    }),
    /No removable revisions/,
  );
});

test('disk space gate blocks new revisions without silent pruning', () => {
  assert.throws(
    () => assertEnoughDiskSpace({ freeBytes: 1_000, minFreeBytes: 50_000 }),
    /Insufficient disk space.*clean up old revisions/,
  );
  assert.doesNotThrow(() => assertEnoughDiskSpace({
    freeBytes: 100_000,
    minFreeBytes: 50_000,
  }));
});
