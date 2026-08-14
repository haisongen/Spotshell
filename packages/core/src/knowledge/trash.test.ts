import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  assertCanMoveToTrash,
  buildTrashRecord,
  computeExpiresAt,
  daysRemaining,
  isExpired,
  planEnvironmentDelete,
  planModuleDelete,
  planPermanentDelete,
  planRestoreAssociations,
  selectExpiredTrashEntries,
} from './trash.js';

const MODULE_ID = '11111111-1111-4111-8111-111111111111';
const ENV_ID = '22222222-2222-4222-8222-222222222222';
const HOST_ID = 'host-1';

test('default retention is 30 days and expiry is computed from deletedAt', () => {
  assert.equal(DEFAULT_TRASH_RETENTION_DAYS, 30);
  const deletedAt = '2026-08-01T00:00:00.000Z';
  const expiresAt = computeExpiresAt(deletedAt);
  assert.equal(expiresAt, '2026-08-31T00:00:00.000Z');
  assert.equal(isExpired(expiresAt, new Date('2026-08-30T23:59:59.000Z')), false);
  assert.equal(isExpired(expiresAt, new Date('2026-08-31T00:00:00.000Z')), true);
  assert.equal(daysRemaining(expiresAt, new Date('2026-08-21T12:00:00.000Z')), 10);
});

test('planModuleDelete blocks while environments still reference the module', () => {
  const preview = planModuleDelete({
    id: MODULE_ID,
    name: 'Nginx rules',
    now: new Date('2026-08-05T00:00:00.000Z'),
    referencedBy: [
      {
        environmentId: ENV_ID,
        environmentName: 'Prod',
        mode: 'always',
      },
    ],
  });

  assert.equal(preview.canDelete, false);
  assert.equal(preview.kind, 'knowledge');
  assert.equal(preview.referencedBy.length, 1);
  assert.equal(preview.blockers[0]?.code, 'module-referenced');
  assert.equal(preview.retentionDays, 30);
  assert.equal(preview.estimatedExpiresAt, '2026-09-04T00:00:00.000Z');
  assert.throws(() => assertCanMoveToTrash(preview), /still referenced/i);
});

test('planModuleDelete allows unreferenced modules', () => {
  const preview = planModuleDelete({
    id: MODULE_ID,
    name: 'Standalone',
    now: new Date('2026-08-05T00:00:00.000Z'),
    referencedBy: [],
  });

  assert.equal(preview.canDelete, true);
  assert.deepEqual(preview.blockers, []);
  assert.doesNotThrow(() => assertCanMoveToTrash(preview));
});

test('planEnvironmentDelete blocks while hosts remain bound', () => {
  const preview = planEnvironmentDelete({
    id: ENV_ID,
    name: 'Prod',
    now: new Date('2026-08-05T00:00:00.000Z'),
    boundHosts: [{ hostId: HOST_ID, hostName: 'db-1' }],
    associations: { always: [MODULE_ID], onDemand: [] },
  });

  assert.equal(preview.canDelete, false);
  assert.equal(preview.blockers[0]?.code, 'environment-bound');
  assert.equal(preview.boundHosts.length, 1);
  assert.throws(() => assertCanMoveToTrash(preview), /bound to .*host/i);
});

test('planEnvironmentDelete allows unbound environments and captures associations', () => {
  const preview = planEnvironmentDelete({
    id: ENV_ID,
    name: 'Prod',
    now: new Date('2026-08-05T00:00:00.000Z'),
    boundHosts: [],
    associations: { always: [MODULE_ID], onDemand: [] },
  });

  assert.equal(preview.canDelete, true);
  assert.deepEqual(preview.associations.always, [MODULE_ID]);
  assert.doesNotThrow(() => assertCanMoveToTrash(preview));
});

test('buildTrashRecord stores stable id, revision, and reference snapshot', () => {
  const record = buildTrashRecord({
    id: MODULE_ID,
    kind: 'knowledge',
    name: 'Nginx rules',
    deletedAt: '2026-08-05T00:00:00.000Z',
    latestRevision: 3,
    contentHash: 'a'.repeat(64),
    referenceSnapshot: {
      referencedBy: [],
      associations: { always: [], onDemand: [] },
      boundHosts: [],
    },
  });

  assert.equal(record.id, MODULE_ID);
  assert.equal(record.latestRevision, 3);
  assert.equal(record.expiresAt, '2026-09-04T00:00:00.000Z');
  assert.equal(record.contentHash?.length, 64);
});

test('planRestoreAssociations reuses original links without overwriting conflicts', () => {
  const plan = planRestoreAssociations({
    kind: 'environment',
    snapshot: {
      referencedBy: [],
      associations: {
        always: [MODULE_ID, '33333333-3333-4333-8333-333333333333'],
        onDemand: ['44444444-4444-4444-8444-444444444444'],
      },
      boundHosts: [],
    },
    availableModuleIds: new Set([MODULE_ID, '44444444-4444-4444-8444-444444444444']),
    // Current environment draft already associates MODULE_ID as on_demand (conflict)
    currentAssociations: {
      always: [],
      onDemand: [MODULE_ID],
    },
  });

  const byId = new Map(plan.map((entry) => [entry.moduleId, entry]));
  assert.equal(byId.get(MODULE_ID)?.status, 'skipped-conflict');
  assert.equal(byId.get('33333333-3333-4333-8333-333333333333')?.status, 'skipped-missing');
  assert.equal(byId.get('44444444-4444-4444-8444-444444444444')?.status, 'restored');
  assert.equal(byId.get('44444444-4444-4444-8444-444444444444')?.mode, 'on_demand');
});

test('planPermanentDelete blocks agent-active objects and surfaces retention', () => {
  const record = buildTrashRecord({
    id: MODULE_ID,
    kind: 'knowledge',
    name: 'Nginx rules',
    deletedAt: '2026-08-05T00:00:00.000Z',
    latestRevision: 2,
    contentHash: 'b'.repeat(64),
    referenceSnapshot: {
      referencedBy: [],
      associations: { always: [], onDemand: [] },
      boundHosts: [],
    },
  });

  const blocked = planPermanentDelete({
    record,
    now: new Date('2026-08-10T00:00:00.000Z'),
    agentActiveRevisions: [2],
  });
  assert.equal(blocked.canPermanentlyDelete, false);
  assert.equal(blocked.blockers[0]?.code, 'agent-active');
  assert.equal(blocked.irreversible, true);
  assert.equal(blocked.daysRemaining, 25);

  const allowed = planPermanentDelete({
    record,
    now: new Date('2026-08-10T00:00:00.000Z'),
    agentActiveRevisions: [],
  });
  assert.equal(allowed.canPermanentlyDelete, true);
});

test('selectExpiredTrashEntries returns only past-retention records', () => {
  const active = buildTrashRecord({
    id: MODULE_ID,
    kind: 'knowledge',
    name: 'Active',
    deletedAt: '2026-08-01T00:00:00.000Z',
    referenceSnapshot: {
      referencedBy: [],
      associations: { always: [], onDemand: [] },
      boundHosts: [],
    },
  });
  const expired = buildTrashRecord({
    id: ENV_ID,
    kind: 'environment',
    name: 'Expired',
    deletedAt: '2026-06-01T00:00:00.000Z',
    referenceSnapshot: {
      referencedBy: [],
      associations: { always: [], onDemand: [] },
      boundHosts: [],
    },
  });

  const selected = selectExpiredTrashEntries(
    [active, expired],
    new Date('2026-08-05T00:00:00.000Z'),
  );
  assert.deepEqual(selected.map((entry) => entry.id), [ENV_ID]);
});
