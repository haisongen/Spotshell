import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCommand } from '../agent/risk.js';
import {
  extractInlineGuidance,
  parseSpaceDocument,
  serializeSpaceDocument,
} from './spaceDocument.js';
import {
  buildOfficialSeedPackage,
  getOfficialSeedByKey,
  HEALTH_CHECK_COMMANDS,
  OFFICIAL_SEED_MODULES,
  officialSeedDocument,
  serializeOfficialSeedPackage,
} from './seedModules.js';

test('every health-check command classifies readonly (policy safety fuse)', () => {
  assert.ok(HEALTH_CHECK_COMMANDS.length >= 5);
  for (const cmd of HEALTH_CHECK_COMMANDS) {
    assert.equal(classifyCommand(cmd), 'readonly', cmd);
  }
});

test('seven official seeds have stable ids, schema v1, guidance, and routing metadata', () => {
  assert.equal(OFFICIAL_SEED_MODULES.length, 7);
  const keys = OFFICIAL_SEED_MODULES.map((seed) => seed.key).sort();
  assert.deepEqual(keys, [
    'cert-expiry',
    'disk-full',
    'hdfs-yarn',
    'healthcheck',
    'oom',
    'port-conflict',
    'service-down',
  ]);

  const ids = new Set<string>();
  for (const seed of OFFICIAL_SEED_MODULES) {
    assert.ok(!ids.has(seed.id), `duplicate id ${seed.id}`);
    ids.add(seed.id);
    assert.match(seed.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const document = officialSeedDocument(seed);
    assert.equal(document.metadata.kind, 'knowledge');
    assert.equal(document.metadata.schema_version, 1);
    assert.equal(document.metadata.id, seed.id);
    assert.ok(document.metadata.name.trim());
    assert.ok(document.metadata.description.trim());
    assert.ok(document.metadata.when_to_use.trim());
    assert.ok(extractInlineGuidance(document)?.trim(), `${seed.key} must declare ## Guidance`);

    // Round-trip must stay hash-stable for package identity.
    const again = parseSpaceDocument(serializeSpaceDocument(document));
    assert.equal(again.metadata.id, seed.id);
  }
});

test('healthcheck seed embeds the exact readonly command list', () => {
  const seed = getOfficialSeedByKey('healthcheck');
  assert.ok(seed);
  for (const cmd of HEALTH_CHECK_COMMANDS) {
    assert.ok(seed.body.includes(cmd), cmd);
  }
  const built = buildOfficialSeedPackage(seed);
  assert.equal(built.package.id, seed.id);
  assert.equal(built.contentHash.length, 64);
  assert.match(built.contentHash, /^[a-f0-9]{64}$/);
});

test('official seed packages are deterministic for the same content', () => {
  const seed = getOfficialSeedByKey('disk-full')!;
  const first = serializeOfficialSeedPackage(seed, '2026-01-01T00:00:00.000Z');
  const second = serializeOfficialSeedPackage(seed, '2026-01-01T00:00:00.000Z');
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.package.content_hash, first.contentHash);
  assert.equal(first.text, second.text);
});

test('seed when_to_use covers disk, OOM, service, port, cert, hdfs and healthcheck signals', () => {
  const byKey = Object.fromEntries(
    OFFICIAL_SEED_MODULES.map((seed) => [seed.key, seed.whenToUse.toLowerCase()]),
  );
  assert.match(byKey.healthcheck!, /health check|体检/);
  assert.match(byKey['disk-full']!, /disk|磁盘/);
  assert.match(byKey.oom!, /oom|memory|内存/);
  assert.match(byKey['service-down']!, /service|服务/);
  assert.match(byKey['port-conflict']!, /port|端口/);
  assert.match(byKey['cert-expiry']!, /cert|证书/);
  assert.match(byKey['hdfs-yarn']!, /hdfs|yarn/);
});
