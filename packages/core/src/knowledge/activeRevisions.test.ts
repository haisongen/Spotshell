import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPendingRevision,
  createPendingRevisionApply,
  detectRevisionUpdates,
  dismissRevisionUpdate,
  ensureActivePin,
  formatVersionSwitchContextEvent,
  type ActiveRevisionPin,
  type LatestRevisionSnapshot,
  type PendingRevisionApply,
  type RevisionUpdateAvailable,
} from './activeRevisions.js';

function pin(overrides: Partial<ActiveRevisionPin> = {}): ActiveRevisionPin {
  return {
    objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'knowledge',
    name: 'JVM Diagnostics',
    revision: 1,
    contentHash: 'hash-v1',
    ...overrides,
  };
}

function latest(overrides: Partial<LatestRevisionSnapshot> = {}): LatestRevisionSnapshot {
  return {
    objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'knowledge',
    name: 'JVM Diagnostics',
    revision: 2,
    contentHash: 'hash-v2',
    ...overrides,
  };
}

test('ensureActivePin keeps an existing pin instead of hot-reloading latest', () => {
  const existing = pin({ revision: 1, contentHash: 'hash-v1' });
  const pins = new Map([[existing.objectId, existing]]);
  const result = ensureActivePin(pins, latest({ revision: 3, contentHash: 'hash-v3' }));
  assert.equal(result.pin.revision, 1);
  assert.equal(result.pin.contentHash, 'hash-v1');
  assert.equal(result.created, false);
  assert.equal(pins.get(existing.objectId)?.revision, 1);
});

test('ensureActivePin creates a pin from the current latest when object first becomes active', () => {
  const pins = new Map<string, ActiveRevisionPin>();
  const snapshot = latest({ revision: 4, contentHash: 'hash-v4' });
  const result = ensureActivePin(pins, snapshot);
  assert.equal(result.created, true);
  assert.equal(result.pin.revision, 4);
  assert.equal(result.pin.contentHash, 'hash-v4');
  assert.equal(pins.get(snapshot.objectId)?.revision, 4);
});

test('detectRevisionUpdates reports objects whose latest differs from the active pin', () => {
  const pins = new Map([
    [pin().objectId, pin()],
    [
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pin({
        objectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'Current',
        revision: 2,
        contentHash: 'same',
      }),
    ],
  ]);
  const updates = detectRevisionUpdates(pins, [
    latest({ revision: 2, contentHash: 'hash-v2' }),
    latest({
      objectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Current',
      revision: 2,
      contentHash: 'same',
    }),
    latest({
      objectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Not active',
      revision: 9,
      contentHash: 'ignored',
    }),
  ]);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    objectId: pin().objectId,
    kind: 'knowledge',
    name: 'JVM Diagnostics',
    activeRevision: 1,
    activeContentHash: 'hash-v1',
    latestRevision: 2,
    latestContentHash: 'hash-v2',
  } satisfies RevisionUpdateAvailable);
});

test('dismissRevisionUpdate hides one latest snapshot until the target changes again', () => {
  const update = detectRevisionUpdates(new Map([[pin().objectId, pin()]]), [latest()])[0]!;
  const dismissed = dismissRevisionUpdate(new Set(), update);
  assert.equal(detectRevisionUpdates(
    new Map([[pin().objectId, pin()]]),
    [latest()],
    dismissed,
  ).length, 0);

  const newer = latest({ revision: 3, contentHash: 'hash-v3' });
  const resurfaced = detectRevisionUpdates(
    new Map([[pin().objectId, pin()]]),
    [newer],
    dismissed,
  );
  assert.equal(resurfaced.length, 1);
  assert.equal(resurfaced[0]?.latestRevision, 3);
});

test('applyPendingRevision updates only the target pin and returns a version switch event', () => {
  const other = pin({
    objectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Other',
    revision: 5,
    contentHash: 'other-hash',
  });
  const pins = new Map([
    [pin().objectId, pin()],
    [other.objectId, other],
  ]);
  const pending = createPendingRevisionApply(latest(), '2026-08-04T12:00:00.000Z');
  const result = applyPendingRevision(pins, pending, latest());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pin.revision, 2);
  assert.equal(result.pin.contentHash, 'hash-v2');
  assert.equal(pins.get(other.objectId)?.revision, 5);
  assert.equal(result.event.fromRevision, 1);
  assert.equal(result.event.toRevision, 2);
  assert.equal(result.event.objectId, pin().objectId);
  assert.match(formatVersionSwitchContextEvent(result.event), /JVM Diagnostics/);
  assert.match(formatVersionSwitchContextEvent(result.event), /revision 1/);
  assert.match(formatVersionSwitchContextEvent(result.event), /revision 2/);
});

test('applyPendingRevision rejects a stale confirmation when the target revision changed', () => {
  const pins = new Map([[pin().objectId, pin()]]);
  const pending: PendingRevisionApply = createPendingRevisionApply(
    latest({ revision: 2, contentHash: 'hash-v2' }),
    '2026-08-04T12:00:00.000Z',
  );
  const result = applyPendingRevision(
    pins,
    pending,
    latest({ revision: 3, contentHash: 'hash-v3' }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'stale-target');
  assert.equal(pins.get(pin().objectId)?.revision, 1);
});

test('applyPendingRevision rejects when the object is no longer active', () => {
  const pins = new Map<string, ActiveRevisionPin>();
  const pending = createPendingRevisionApply(latest(), '2026-08-04T12:00:00.000Z');
  const result = applyPendingRevision(pins, pending, latest());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not-active');
});
