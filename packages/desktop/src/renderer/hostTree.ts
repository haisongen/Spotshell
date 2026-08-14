import type { HostFolder, HostProfile, HostTreeSnapshot } from '@spotshell/core'

export const ROOT_FOLDER_ID = '__spotshell_root__'

export interface HostTreeFolderNode {
  kind: 'folder'
  id: string
  name: string
  parentId?: string
  isRoot: boolean
  folder?: HostFolder
  folders: HostTreeFolderNode[]
  hosts: HostProfile[]
}

export interface BuildHostTreeOptions {
  rootName?: string
  locale?: string | string[]
}

export type HostTreeVisibleRow =
  | {
      kind: 'folder'
      id: string
      node: HostTreeFolderNode
      depth: number
      ariaLevel: number
      parentId?: string
      hasChildren: boolean
      expanded: boolean
    }
  | {
      kind: 'host'
      id: string
      host: HostProfile
      depth: number
      ariaLevel: number
      parentId: string
    }

export interface HostTreeSearchResult {
  tree: HostTreeFolderNode
  expandedIds: Set<string>
  isSearching: boolean
  hasMatches: boolean
}

export type HostDropTarget =
  | { kind: 'folder'; folderId: string }
  | { kind: 'root' }
  | { kind: 'tree-background' }
  | { kind: 'invalid' }

export type HostDropResolution =
  | { valid: false; changed: false }
  | { valid: true; changed: boolean; folderId?: string }

/**
 * Builds a renderer-safe tree. Invalid parent references and parent cycles are
 * attached to the virtual root so malformed snapshots cannot hide hosts.
 */
export function buildHostTree(
  snapshot: HostTreeSnapshot,
  options: BuildHostTreeOptions = {}
): HostTreeFolderNode {
  const root: HostTreeFolderNode = {
    kind: 'folder',
    id: ROOT_FOLDER_ID,
    name: options.rootName ?? 'Main',
    isRoot: true,
    folders: [],
    hosts: [],
  }
  const foldersById = new Map<string, HostTreeFolderNode>()

  for (const folder of snapshot.folders) {
    if (!folder.id || folder.id === ROOT_FOLDER_ID || foldersById.has(folder.id)) continue
    foldersById.set(folder.id, {
      kind: 'folder',
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      isRoot: false,
      folder,
      folders: [],
      hosts: [],
    })
  }

  const hasValidParentPath = (folder: HostTreeFolderNode): boolean => {
    const visited = new Set([folder.id])
    let parentId = folder.parentId
    while (parentId !== undefined) {
      if (visited.has(parentId)) return false
      visited.add(parentId)
      const parent = foldersById.get(parentId)
      if (!parent) return false
      parentId = parent.parentId
    }
    return true
  }

  const effectiveParents = new Map<string, HostTreeFolderNode | undefined>()
  for (const folder of foldersById.values()) {
    effectiveParents.set(
      folder.id,
      hasValidParentPath(folder) && folder.parentId
        ? foldersById.get(folder.parentId)
        : undefined
    )
  }
  for (const folder of foldersById.values()) {
    const parent = effectiveParents.get(folder.id)
    folder.parentId = parent?.id
    ;(parent ?? root).folders.push(folder)
  }

  for (const host of snapshot.hosts) {
    const parent = host.folderId ? foldersById.get(host.folderId) : undefined
    ;(parent ?? root).hosts.push(host)
  }

  const collator = new Intl.Collator(options.locale, {
    numeric: true,
    sensitivity: 'base',
  })
  const sortFolders = (folder: HostTreeFolderNode): void => {
    folder.folders.sort((left, right) => collator.compare(left.name, right.name))
    folder.folders.forEach(sortFolders)
  }
  sortFolders(root)

  return root
}

export function createExpandedFolderIds(ids: Iterable<string> = []): Set<string> {
  return new Set([ROOT_FOLDER_ID, ...ids])
}

export function findHostTreeFolder(
  tree: HostTreeFolderNode,
  folderId?: string
): HostTreeFolderNode | undefined {
  if (folderId === undefined || folderId === ROOT_FOLDER_ID) return tree
  const pending = [...tree.folders]
  while (pending.length > 0) {
    const folder = pending.shift()!
    if (folder.id === folderId) return folder
    pending.unshift(...folder.folders)
  }
  return undefined
}

export function getHostTreeFolderPath(
  tree: HostTreeFolderNode,
  folderId?: string
): HostTreeFolderNode[] {
  const target = folderId ?? ROOT_FOLDER_ID
  const visit = (
    folder: HostTreeFolderNode,
    path: HostTreeFolderNode[]
  ): HostTreeFolderNode[] | undefined => {
    const nextPath = [...path, folder]
    if (folder.id === target) return nextPath
    for (const child of folder.folders) {
      const result = visit(child, nextPath)
      if (result) return result
    }
    return undefined
  }
  return visit(tree, []) ?? []
}

export function getDescendantFolderIds(
  tree: HostTreeFolderNode,
  folderId?: string
): string[] {
  const folder = findHostTreeFolder(tree, folderId)
  if (!folder) return []
  const result: string[] = []
  const visit = (node: HostTreeFolderNode): void => {
    for (const child of node.folders) {
      result.push(child.id)
      visit(child)
    }
  }
  visit(folder)
  return result
}

export function getVisibleHostTreeRows(
  tree: HostTreeFolderNode,
  expandedIds: ReadonlySet<string>
): HostTreeVisibleRow[] {
  const rows: HostTreeVisibleRow[] = []
  const visit = (folder: HostTreeFolderNode, depth: number, parentId?: string): void => {
    const hasChildren = folder.folders.length > 0 || folder.hosts.length > 0
    const expanded = hasChildren && expandedIds.has(folder.id)
    rows.push({
      kind: 'folder',
      id: folder.id,
      node: folder,
      depth,
      ariaLevel: depth,
      parentId,
      hasChildren,
      expanded,
    })
    if (!expanded) return
    for (const child of folder.folders) visit(child, depth + 1, folder.id)
    for (const host of folder.hosts) {
      rows.push({
        kind: 'host',
        id: host.id,
        host,
        depth: depth + 1,
        ariaLevel: depth + 1,
        parentId: folder.id,
      })
    }
  }
  visit(tree, 1)
  return rows
}

export function searchHostTree(
  tree: HostTreeFolderNode,
  query: string,
  userExpandedIds: ReadonlySet<string>
): HostTreeSearchResult {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) {
    return {
      tree,
      expandedIds: new Set(userExpandedIds),
      isSearching: false,
      hasMatches: true,
    }
  }

  const expandedIds = new Set<string>()
  const includesQuery = (value: string): boolean =>
    value.toLocaleLowerCase().includes(normalizedQuery)
  const hostMatches = (host: HostProfile): boolean =>
    [host.name, host.host, host.username, `${host.username}@${host.host}:${host.port}`]
      .some(includesQuery)

  const project = (
    folder: HostTreeFolderNode,
    ancestorMatched: boolean
  ): HostTreeFolderNode | undefined => {
    const folderMatched = includesQuery(folder.name)
    const includeDescendants = ancestorMatched || folderMatched
    const folders = folder.folders
      .map((child) => project(child, includeDescendants))
      .filter((child): child is HostTreeFolderNode => child !== undefined)
    const hosts = includeDescendants ? [...folder.hosts] : folder.hosts.filter(hostMatches)
    const included = folder.isRoot || includeDescendants || folders.length > 0 || hosts.length > 0
    if (!included) return undefined
    if (folders.length > 0 || hosts.length > 0) expandedIds.add(folder.id)
    return { ...folder, folders, hosts }
  }

  const projectedTree = project(tree, false)!
  const hasMatches = projectedTree.folders.length > 0 || projectedTree.hosts.length > 0 ||
    includesQuery(projectedTree.name)
  if (!hasMatches) expandedIds.add(ROOT_FOLDER_ID)

  return {
    tree: projectedTree,
    expandedIds,
    isSearching: true,
    hasMatches,
  }
}

export function resolveHostDropTarget(
  tree: HostTreeFolderNode,
  target: HostDropTarget,
  currentFolderId?: string
): HostDropResolution {
  if (target.kind === 'invalid') return { valid: false, changed: false }

  const folderId = target.kind === 'folder' && target.folderId !== ROOT_FOLDER_ID
    ? target.folderId
    : undefined
  if (folderId !== undefined && !findHostTreeFolder(tree, folderId)) {
    return { valid: false, changed: false }
  }
  return {
    valid: true,
    changed: folderId !== currentFolderId,
    folderId,
  }
}
