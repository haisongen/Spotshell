import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostStore } from './HostStore.js';

describe('HostStore', () => {
  let dir: string;
  let store: HostStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-hosts-'));
    store = new HostStore(path.join(dir, 'hosts.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty', () => {
    assert.deepEqual(store.list(), []);
  });

  it('adds and lists hosts without passwords', () => {
    const host = store.add({
      name: 'prod',
      host: '10.0.0.1',
      port: 22,
      username: 'ubuntu',
      privateKeyPath: 'C:/Users/me/.ssh/id_rsa',
    });
    assert.ok(host.id);
    assert.equal(store.list().length, 1);
    const raw = fs.readFileSync(path.join(dir, 'hosts.json'), 'utf8');
    assert.equal(raw.includes('password'), false);
  });

  it('updates and deletes', () => {
    const host = store.add({
      name: 'a',
      host: 'h',
      port: 22,
      username: 'u',
    });
    store.update(host.id, { name: 'b' });
    assert.equal(store.list()[0]?.name, 'b');
    store.remove(host.id);
    assert.deepEqual(store.list(), []);
  });
});

function tmpStore(): { store: HostStore; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-hosts-')), 'hosts.json');
  return { store: new HostStore(file), file };
}

describe('HostStore notes', () => {
  it('persists notes through add / get / disk round-trip', () => {
    const { store, file } = tmpStore();
    const host = store.add({
      name: 'cdh', host: '10.0.0.1', port: 22, username: 'root',
      notes: 'CDH 6.3 集群，Kerberos 认证，stderr 的 GSS 报错可忽略',
    });
    assert.equal(store.get(host.id)?.notes, 'CDH 6.3 集群，Kerberos 认证，stderr 的 GSS 报错可忽略');
    // 换一个实例从磁盘重读
    assert.equal(new HostStore(file).get(host.id)?.notes?.includes('CDH 6.3'), true);
  });

  it('updates notes via patch and clears with empty string', () => {
    const { store } = tmpStore();
    const host = store.add({ name: 'a', host: 'h', port: 22, username: 'u' });
    assert.equal(store.get(host.id)?.notes, undefined);
    store.update(host.id, { notes: 'K8s node' });
    assert.equal(store.get(host.id)?.notes, 'K8s node');
    store.update(host.id, { notes: '' });
    assert.equal(store.get(host.id)?.notes, undefined);
  });

  it('drops non-string notes read from a tampered file', () => {
    const { store, file } = tmpStore();
    const host = store.add({ name: 'a', host: 'h', port: 22, username: 'u' });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.hosts[0].notes = { evil: true };
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(new HostStore(file).get(host.id)?.notes, undefined);
  });
});

describe('HostStore environment bindings', () => {
  it('persists, changes, clears, and reverse-lists saved-host bindings', () => {
    const { store, file } = tmpStore();
    const first = store.add({
      name: 'prod-a', host: '10.0.0.1', port: 22, username: 'ops', environmentId: 'env-prod',
    });
    const second = store.add({
      name: 'prod-b', host: '10.0.0.2', port: 22, username: 'ops', environmentId: 'env-prod',
    });

    assert.equal(new HostStore(file).get(first.id)?.environmentId, 'env-prod');
    assert.deepEqual(
      store.listByEnvironmentId('env-prod').map((host) => host.id),
      [first.id, second.id],
    );

    assert.equal(store.update(first.id, { environmentId: 'env-stage' }).environmentId, 'env-stage');
    assert.equal(store.update(second.id, { environmentId: undefined }).environmentId, undefined);
    assert.deepEqual(store.listByEnvironmentId('env-prod'), []);
    assert.deepEqual(store.listByEnvironmentId('env-stage').map((host) => host.id), [first.id]);
  });

  it('drops malformed environment bindings read from disk', () => {
    const { store, file } = tmpStore();
    const host = store.add({ name: 'prod', host: 'h', port: 22, username: 'u' });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.hosts[0].environmentId = { invalid: true };
    fs.writeFileSync(file, JSON.stringify(raw));

    assert.equal(new HostStore(file).get(host.id)?.environmentId, undefined);
  });
});

describe('HostStore.appendNote', () => {
  it('appends a stamped entry to empty and existing notes', () => {
    const { store } = tmpStore();
    const host = store.add({ name: 'a', host: 'h', port: 22, username: 'u' });

    const first = store.appendNote(host.id, 'HDFS 的 GSS 报错无害', '2026-07-17');
    assert.equal(first?.notes, '[AI 2026-07-17] HDFS 的 GSS 报错无害');

    const second = store.appendNote(host.id, '磁盘满通常是 /var/log/app', '2026-07-18');
    assert.equal(
      second?.notes,
      '[AI 2026-07-17] HDFS 的 GSS 报错无害\n\n[AI 2026-07-18] 磁盘满通常是 /var/log/app'
    );
  });

  it('returns null and keeps notes unchanged when the 4000-char cap would be exceeded', () => {
    const { store } = tmpStore();
    const host = store.add({
      name: 'a', host: 'h', port: 22, username: 'u', notes: 'x'.repeat(3990),
    });
    assert.equal(store.appendNote(host.id, 'y'.repeat(50), '2026-07-17'), null);
    assert.equal(store.get(host.id)?.notes, 'x'.repeat(3990));
  });

  it('throws for unknown host', () => {
    const { store } = tmpStore();
    assert.throws(() => store.appendNote('nope', 'n', '2026-07-17'));
  });
});

describe('HostStore folder tree persistence', () => {
  it('treats the system root as an empty virtual folder for a new store', () => {
    const { store } = tmpStore();
    assert.deepEqual(store.getTree(), { folders: [], hosts: [] });
  });

  it('migrates v1 hosts to the root without changing ids, order, or profile data', () => {
    const { store, file } = tmpStore();
    const legacyHosts = [
      { id: 'one', name: 'First', host: '10.0.0.1', port: 22, username: 'root', notes: 'keep me' },
      { id: 'two', name: 'Second', host: 'example.com', port: 2202, username: 'ops', authMethod: 'agent' },
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: legacyHosts }));

    const tree = store.getTree();
    assert.deepEqual(tree.folders, []);
    assert.deepEqual(tree.hosts.map((host) => host.id), ['one', 'two']);
    assert.equal(tree.hosts[0]?.notes, 'keep me');
    assert.equal(tree.hosts[1]?.port, 2202);
    assert.equal(tree.hosts.every((host) => host.folderId === undefined), true);

    store.update('one', { name: 'First updated' });
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.folders, []);
    assert.deepEqual(persisted.hosts.map((host: { id: string }) => host.id), ['one', 'two']);
  });

  it('repairs unknown parents, unknown host folders, cycles, and malformed folders', () => {
    const { store, file } = tmpStore();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      folders: [
        { id: 'orphan', name: 'Orphan', parentId: 'missing' },
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
        { id: 'valid', name: 'Valid' },
        { id: 'bad-name', name: '' },
        { name: 'Missing id' },
      ],
      hosts: [
        { id: 'known', name: 'Known', host: 'h1', port: 22, username: 'u', folderId: 'valid' },
        { id: 'unknown', name: 'Unknown', host: 'h2', port: 22, username: 'u', folderId: 'missing' },
        { id: 'bad-folder', name: 'Bad folder', host: 'h3', port: 22, username: 'u', folderId: 'bad-name' },
      ],
    }));

    const tree = store.getTree();
    assert.deepEqual(tree.folders.map((folder) => folder.id), ['orphan', 'a', 'b', 'valid']);
    assert.equal(tree.folders.find((folder) => folder.id === 'orphan')?.parentId, undefined);
    assert.equal(tree.folders.find((folder) => folder.id === 'a')?.parentId, undefined);
    assert.equal(tree.folders.find((folder) => folder.id === 'b')?.parentId, undefined);
    assert.equal(tree.hosts.find((host) => host.id === 'known')?.folderId, 'valid');
    assert.equal(tree.hosts.find((host) => host.id === 'unknown')?.folderId, undefined);
    assert.equal(tree.hosts.find((host) => host.id === 'bad-folder')?.folderId, undefined);
    assert.equal(tree.hosts.length, 3);
  });
});

describe('HostStore folder transactions', () => {
  it('creates nested folders and enforces trimmed, case-insensitive sibling names', () => {
    const { store } = tmpStore();
    const parent = store.addFolder({ name: ' Environments ' });
    const child = store.addFolder({ name: 'Production', parentId: parent.id });
    assert.equal(parent.name, 'Environments');
    assert.equal(child.parentId, parent.id);
    assert.throws(() => store.addFolder({ name: 'environments' }), /already exists/);
    assert.throws(() => store.addFolder({ name: 'production', parentId: parent.id }), /already exists/);
    assert.throws(() => store.addFolder({ name: '   ' }), /must not be empty/);
    assert.throws(() => store.addFolder({ name: 'x'.repeat(101) }), /must not exceed/);
    assert.throws(() => store.addFolder({ name: 'child', parentId: 'missing' }), /Folder not found/);
  });

  it('renames folders with the same validation rules', () => {
    const { store } = tmpStore();
    const first = store.addFolder({ name: 'First' });
    store.addFolder({ name: 'Second' });
    assert.equal(store.renameFolder(first.id, ' Renamed ').name, 'Renamed');
    assert.throws(() => store.renameFolder(first.id, 'second'), /already exists/);
    assert.throws(() => store.renameFolder(first.id, ''), /must not be empty/);
    assert.throws(() => store.renameFolder('missing', 'Name'), /Folder not found/);
  });

  it('moves hosts between nested folders and the root and rejects missing targets', () => {
    const { store } = tmpStore();
    const parent = store.addFolder({ name: 'Parent' });
    const child = store.addFolder({ name: 'Child', parentId: parent.id });
    const host = store.add({ name: 'server', host: 'h', port: 22, username: 'u', folderId: parent.id });
    assert.equal(store.moveHost(host.id, child.id).folderId, child.id);
    assert.equal(store.moveHost(host.id).folderId, undefined);
    assert.throws(() => store.moveHost(host.id, 'missing'), /Folder not found/);
    assert.throws(() => store.moveHost('missing', parent.id), /Host not found/);
    assert.throws(
      () => store.add({ name: 'bad', host: 'h', port: 22, username: 'u', folderId: 'missing' }),
      /Folder not found/,
    );
  });

  it('removes an empty folder', () => {
    const { store } = tmpStore();
    const folder = store.addFolder({ name: 'Empty' });
    assert.deepEqual(store.removeFolder(folder.id), {
      removedFolderId: folder.id,
      parentId: undefined,
      movedHostCount: 0,
      movedFolderCount: 0,
    });
    assert.deepEqual(store.listFolders(), []);
  });

  it('moves only direct hosts and child folders to the parent without changing host data', () => {
    const { store } = tmpStore();
    const parent = store.addFolder({ name: 'Parent' });
    const removed = store.addFolder({ name: 'Removed', parentId: parent.id });
    const child = store.addFolder({ name: 'Child', parentId: removed.id });
    const direct = store.add({
      id: 'stable-id', name: 'direct', host: 'h', port: 22, username: 'u',
      notes: 'preserved', folderId: removed.id,
    });
    const nested = store.add({ name: 'nested', host: 'nested', port: 22, username: 'u', folderId: child.id });

    assert.deepEqual(store.removeFolder(removed.id), {
      removedFolderId: removed.id,
      parentId: parent.id,
      movedHostCount: 1,
      movedFolderCount: 1,
    });
    assert.equal(store.listFolders().find((folder) => folder.id === child.id)?.parentId, parent.id);
    assert.equal(store.get(direct.id)?.folderId, parent.id);
    assert.equal(store.get(direct.id)?.id, 'stable-id');
    assert.equal(store.get(direct.id)?.notes, 'preserved');
    assert.equal(store.get(nested.id)?.folderId, child.id);
  });

  it('rejects removal atomically when moving a child would create a sibling conflict', () => {
    const { store, file } = tmpStore();
    const outerConflict = store.addFolder({ name: 'Conflict' });
    const removed = store.addFolder({ name: 'Container' });
    store.addFolder({ name: outerConflict.name.toLowerCase(), parentId: removed.id });
    const host = store.add({ name: 'host', host: 'h', port: 22, username: 'u', folderId: removed.id });
    const before = fs.readFileSync(file, 'utf8');

    assert.throws(() => store.removeFolder(removed.id), /already exists/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(store.get(host.id)?.folderId, removed.id);
    assert.equal(store.listFolders().some((folder) => folder.id === removed.id), true);
  });
});
