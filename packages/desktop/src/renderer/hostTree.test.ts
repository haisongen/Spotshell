import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostTreeSnapshot } from '@spotshell/core'
import {
  ROOT_FOLDER_ID,
  buildHostTree,
  createExpandedFolderIds,
  getDescendantFolderIds,
  getHostTreeFolderPath,
  getVisibleHostTreeRows,
  resolveHostDropTarget,
  searchHostTree,
} from './hostTree'

const snapshot: HostTreeSnapshot = {
  folders: [
    { id: 'staging', name: 'Staging' },
    { id: 'prod', name: 'Production' },
    { id: 'db', name: 'Database', parentId: 'prod' },
    { id: 'archive', name: 'Archive', parentId: 'db' },
  ],
  hosts: [
    { id: 'root-2', name: 'Root second', host: 'root-2.local', port: 22, username: 'root' },
    { id: 'prod-1', name: 'API', host: '10.0.0.8', port: 2222, username: 'deploy', folderId: 'prod' },
    { id: 'root-1', name: 'Root first', host: 'root-1.local', port: 22, username: 'ops' },
    { id: 'db-1', name: 'Primary DB', host: 'db.internal', port: 22, username: 'postgres', folderId: 'db' },
  ],
}

test('builds a sorted folder tree while preserving saved host order', () => {
  const tree = buildHostTree(snapshot)
  assert.deepEqual(tree.folders.map((folder) => folder.id), ['prod', 'staging'])
  assert.deepEqual(tree.hosts.map((host) => host.id), ['root-2', 'root-1'])
  assert.deepEqual(tree.folders[0].folders.map((folder) => folder.id), ['db'])
})

test('returns parent paths, descendants, visible rows, and aria levels', () => {
  const tree = buildHostTree(snapshot)
  assert.deepEqual(
    getHostTreeFolderPath(tree, 'archive').map((folder) => folder.id),
    [ROOT_FOLDER_ID, 'prod', 'db', 'archive']
  )
  assert.deepEqual(getDescendantFolderIds(tree, 'prod'), ['db', 'archive'])

  const rows = getVisibleHostTreeRows(tree, createExpandedFolderIds(['prod', 'db']))
  assert.deepEqual(rows.map((row) => [row.kind, row.id, row.ariaLevel]), [
    ['folder', ROOT_FOLDER_ID, 1],
    ['folder', 'prod', 2],
    ['folder', 'db', 3],
    ['folder', 'archive', 4],
    ['host', 'db-1', 4],
    ['host', 'prod-1', 3],
    ['folder', 'staging', 2],
    ['host', 'root-2', 2],
    ['host', 'root-1', 2],
  ])
})

test('the root starts expanded but can be collapsed for the current session', () => {
  const tree = buildHostTree(snapshot)
  const initiallyVisible = getVisibleHostTreeRows(tree, createExpandedFolderIds())
  assert.equal(initiallyVisible[0].kind, 'folder')
  assert.equal(initiallyVisible[0].kind === 'folder' && initiallyVisible[0].expanded, true)
  assert.ok(initiallyVisible.length > 1)

  const collapsed = getVisibleHostTreeRows(tree, new Set())
  assert.deepEqual(collapsed.map((row) => row.id), [ROOT_FOLDER_ID])
  assert.equal(collapsed[0].kind === 'folder' && collapsed[0].expanded, false)
})

test('host search keeps its ancestor path and derives expansion without changing user state', () => {
  const tree = buildHostTree(snapshot)
  const userExpanded = createExpandedFolderIds(['staging'])
  const result = searchHostTree(tree, 'postgres@db.internal:22', userExpanded)

  assert.deepEqual(result.tree.folders.map((folder) => folder.id), ['prod'])
  assert.deepEqual(result.tree.folders[0].folders.map((folder) => folder.id), ['db'])
  assert.deepEqual(result.tree.folders[0].folders[0].hosts.map((host) => host.id), ['db-1'])
  assert.deepEqual([...result.expandedIds], ['db', 'prod', ROOT_FOLDER_ID])
  assert.deepEqual([...userExpanded], [ROOT_FOLDER_ID, 'staging'])

  const cleared = searchHostTree(tree, ' ', userExpanded)
  assert.equal(cleared.tree, tree)
  assert.deepEqual([...cleared.expandedIds], [...userExpanded])
})

test('folder search includes the matching folder full subtree and duplicate names stay scoped', () => {
  const duplicateNames: HostTreeSnapshot = {
    folders: [
      { id: 'east', name: 'East' },
      { id: 'west', name: 'West' },
      { id: 'east-db', name: 'Database', parentId: 'east' },
      { id: 'west-db', name: 'Database', parentId: 'west' },
      { id: 'replica', name: 'Replica', parentId: 'east-db' },
    ],
    hosts: [
      { id: 'replica-host', name: 'Replica host', host: 'replica', port: 22, username: 'db', folderId: 'replica' },
    ],
  }
  const result = searchHostTree(buildHostTree(duplicateNames), 'database', new Set())
  assert.deepEqual(result.tree.folders.map((folder) => folder.id), ['east', 'west'])
  assert.deepEqual(getDescendantFolderIds(result.tree, 'east-db'), ['replica'])
  assert.deepEqual(result.tree.folders[0].folders[0].folders[0].hosts.map((host) => host.id), ['replica-host'])
})

test('empty trees and searches without matches remain representable', () => {
  const tree = buildHostTree({ folders: [], hosts: [] }, { rootName: '主目录' })
  assert.deepEqual(getVisibleHostTreeRows(tree, createExpandedFolderIds()), [{
    kind: 'folder', id: ROOT_FOLDER_ID, node: tree, depth: 1, ariaLevel: 1,
    parentId: undefined, hasChildren: false, expanded: false,
  }])
  const result = searchHostTree(buildHostTree(snapshot), 'does-not-exist', new Set())
  assert.equal(result.hasMatches, false)
  assert.deepEqual(result.tree.folders, [])
  assert.deepEqual(result.tree.hosts, [])
})

test('long names are preserved and malformed references safely fall back to root', () => {
  const longName = 'a'.repeat(300)
  const tree = buildHostTree({
    folders: [
      { id: 'orphan', name: longName, parentId: 'missing' },
      { id: 'cycle-a', name: 'Cycle A', parentId: 'cycle-b' },
      { id: 'cycle-b', name: 'Cycle B', parentId: 'cycle-a' },
    ],
    hosts: [
      { id: 'orphan-host', name: 'Orphan host', host: 'host', port: 22, username: 'root', folderId: 'missing' },
    ],
  })
  assert.deepEqual(tree.folders.map((folder) => folder.id), ['orphan', 'cycle-a', 'cycle-b'])
  assert.equal(tree.folders[0].name, longName)
  assert.ok(tree.folders.every((folder) => folder.parentId === undefined))
  assert.deepEqual(tree.hosts.map((host) => host.id), ['orphan-host'])
})

test('resolves folder, root, background, same-folder, and invalid drop targets', () => {
  const tree = buildHostTree(snapshot)
  assert.deepEqual(resolveHostDropTarget(tree, { kind: 'folder', folderId: 'prod' }), {
    valid: true, changed: true, folderId: 'prod',
  })
  assert.deepEqual(resolveHostDropTarget(tree, { kind: 'folder', folderId: 'prod' }, 'prod'), {
    valid: true, changed: false, folderId: 'prod',
  })
  assert.deepEqual(resolveHostDropTarget(tree, { kind: 'root' }, 'prod'), {
    valid: true, changed: true, folderId: undefined,
  })
  assert.deepEqual(resolveHostDropTarget(tree, { kind: 'tree-background' }), {
    valid: true, changed: false, folderId: undefined,
  })
  assert.deepEqual(resolveHostDropTarget(tree, { kind: 'folder', folderId: 'missing' }), {
    valid: false, changed: false,
  })
  assert.deepEqual(resolveHostDropTarget(tree, { kind: 'invalid' }), {
    valid: false, changed: false,
  })
})
