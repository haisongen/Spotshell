import {
  ChevronDown, ChevronRight, Folder, FolderOpen, MoreHorizontal,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import type { HostFolder, SavedHostProfile, SavedHostTreeSnapshot } from '../../shared/ipc-types'
import { formatHostTarget } from '../hostManagement'
import {
  ROOT_FOLDER_ID,
  buildHostTree,
  createExpandedFolderIds,
  getHostTreeFolderPath,
  resolveHostDropTarget,
  searchHostTree,
  type HostTreeFolderNode,
} from '../hostTree'
import { useTranslation } from '../i18n'
import { ConfirmDeleteFolderModal } from './ConfirmDeleteFolderModal'
import { FolderContextMenu } from './FolderContextMenu'
import { HostContextMenu } from './HostContextMenu'
import { MoveHostModal } from './MoveHostModal'

const EXPANDED_STORAGE_KEY = 'spotshell.hostTree.expanded'
const MAX_FOLDER_NAME_LENGTH = 100

interface HostTreeProps {
  snapshot: SavedHostTreeSnapshot
  query: string
  selectedId: string | null
  testingHostId?: string | null
  connectingHostIds?: ReadonlySet<string>
  onSelect: (host: SavedHostProfile) => void
  onConnect: (host: SavedHostProfile) => void
  onAddHost: (folderId?: string) => void
  onEditHost: (host: SavedHostProfile) => void
  onTestHost: (host: SavedHostProfile) => void
  onRequestDeleteHost: (host: SavedHostProfile) => void
  onAddFolder: (parentId: string | undefined, name: string) => Promise<HostFolder | void>
  onRenameFolder: (id: string, name: string) => Promise<void>
  onRemoveFolder: (folder: HostFolder) => Promise<void>
  onMoveHost: (hostId: string, folderId?: string) => Promise<void>
  onClearSearch: () => void
}

interface MenuPosition {
  x: number
  y: number
  returnFocusTo: HTMLElement
}

type OpenMenu =
  | ({ kind: 'host'; host: SavedHostProfile } & MenuPosition)
  | ({ kind: 'folder'; folder: HostTreeFolderNode } & MenuPosition)

type FolderEdit =
  | { mode: 'create'; parentId: string; name: string; error?: string }
  | { mode: 'rename'; folderId: string; name: string; error?: string }

function readExpandedIds(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(EXPANDED_STORAGE_KEY) ?? '[]')
    return createExpandedFolderIds(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return createExpandedFolderIds()
  }
}

export function HostTree(props: HostTreeProps): JSX.Element {
  const { t } = useTranslation()
  const [userExpandedIds, setUserExpandedIds] = useState(readExpandedIds)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [edit, setEdit] = useState<FolderEdit | null>(null)
  const [deleteFolder, setDeleteFolder] = useState<HostTreeFolderNode | null>(null)
  const [moveHost, setMoveHost] = useState<SavedHostProfile | null>(null)
  const [draggedHostId, setDraggedHostId] = useState<string | null>(null)
  const [dropFolderId, setDropFolderId] = useState<string | null>(null)
  const [movingHostId, setMovingHostId] = useState<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverFolderRef = useRef<string | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  const tree = useMemo(() => buildHostTree(props.snapshot, { rootName: t('mainFolder') }), [props.snapshot, t])
  const savedHosts = useMemo(() => new Map(props.snapshot.hosts.map((host) => [host.id, host])), [props.snapshot.hosts])
  const searchResult = useMemo(
    () => searchHostTree(tree, props.query, userExpandedIds),
    [tree, props.query, userExpandedIds]
  )
  const visibleTree = searchResult.tree
  const expandedIds = searchResult.expandedIds

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
  }, [])

  const persistExpanded = (next: Set<string>): void => {
    setUserExpandedIds(next)
    try {
      localStorage.setItem(EXPANDED_STORAGE_KEY,
        JSON.stringify([...next].filter((id) => id !== ROOT_FOLDER_ID)))
    } catch {
      // Expansion remains usable for this renderer session when storage is unavailable.
    }
  }
  const setExpanded = (folderId: string, expanded: boolean): void => {
    const next = new Set(userExpandedIds)
    if (expanded) next.add(folderId)
    else next.delete(folderId)
    persistExpanded(next)
  }
  const toggleFolder = (folder: HostTreeFolderNode): void => {
    if (searchResult.isSearching) return
    setExpanded(folder.id, !userExpandedIds.has(folder.id))
  }
  const expandPath = (folderId?: string): void => {
    const next = new Set(userExpandedIds)
    getHostTreeFolderPath(tree, folderId).forEach((folder) => next.add(folder.id))
    persistExpanded(next)
  }
  const clearHoverTimer = (): void => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    hoverFolderRef.current = null
  }
  const scheduleExpand = (folder: HostTreeFolderNode): void => {
    if (expandedIds.has(folder.id) || hoverFolderRef.current === folder.id) return
    clearHoverTimer()
    hoverFolderRef.current = folder.id
    hoverTimerRef.current = setTimeout(() => {
      setExpanded(folder.id, true)
      clearHoverTimer()
    }, 500)
  }

  const move = async (hostId: string, folderId?: string): Promise<void> => {
    if (movingHostId === hostId) return
    setMovingHostId(hostId)
    try {
      await props.onMoveHost(hostId, folderId)
      expandPath(folderId)
    } finally {
      setMovingHostId(null)
    }
  }

  const submitEdit = async (): Promise<void> => {
    if (!edit) return
    const name = edit.name.trim()
    if (!name) {
      setEdit({ ...edit, error: t('folderNameRequired') })
      return
    }
    if (name.length > MAX_FOLDER_NAME_LENGTH) {
      setEdit({ ...edit, error: t('folderNameTooLong', { max: MAX_FOLDER_NAME_LENGTH }) })
      return
    }
    const parent = edit.mode === 'create'
      ? getHostTreeFolderPath(tree, edit.parentId).at(-1)
      : getHostTreeFolderPath(tree, edit.folderId).at(-2)
    const conflict = parent?.folders.some((folder) =>
      folder.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0 &&
      (edit.mode === 'create' || folder.id !== edit.folderId)
    )
    if (conflict) {
      setEdit({ ...edit, error: t('folderNameConflict') })
      return
    }
    try {
      if (edit.mode === 'create') {
        await props.onAddFolder(edit.parentId === ROOT_FOLDER_ID ? undefined : edit.parentId, name)
        setExpanded(edit.parentId, true)
      } else {
        await props.onRenameFolder(edit.folderId, name)
      }
      setEdit(null)
    } catch {
      // App owns user-visible IPC error reporting; keep the input available for correction.
    }
  }

  const moveTreeFocus = (event: KeyboardEvent<HTMLElement>, folder?: HostTreeFolderNode): void => {
    if (event.target !== event.currentTarget) return
    const items = [...(treeRef.current?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? [])]
    const index = items.indexOf(event.currentTarget)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if (folder && event.key === 'ArrowRight') {
      event.preventDefault()
      if (searchResult.isSearching) {
        const next = items[index + 1]
        const level = Number(event.currentTarget.getAttribute('aria-level'))
        if (next && Number(next.getAttribute('aria-level')) > level) next.focus()
      } else if (!expandedIds.has(folder.id)) setExpanded(folder.id, true)
      else items[index + 1]?.focus()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (folder && expandedIds.has(folder.id) && !searchResult.isSearching) setExpanded(folder.id, false)
      else {
        const level = Number(event.currentTarget.getAttribute('aria-level'))
        for (let previous = index - 1; previous >= 0; previous -= 1) {
          if (Number(items[previous].getAttribute('aria-level')) < level) {
            items[previous].focus()
            break
          }
        }
      }
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
    }
  }

  const openFolderMenu = (folder: HostTreeFolderNode, event: MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    setMenu({ kind: 'folder', folder, x: event.clientX, y: event.clientY, returnFocusTo: event.currentTarget })
  }
  const openHostMenu = (host: SavedHostProfile, x: number, y: number, target: HTMLElement): void => {
    props.onSelect(host)
    setMenu({ kind: 'host', host, x, y, returnFocusTo: target })
  }

  const folderDragOver = (event: DragEvent<HTMLElement>, folder: HostTreeFolderNode): void => {
    if (!draggedHostId) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropFolderId(folder.id)
    scheduleExpand(folder)
  }
  const folderDrop = (event: DragEvent<HTMLElement>, folder: HostTreeFolderNode): void => {
    event.preventDefault()
    event.stopPropagation()
    clearHoverTimer()
    const hostId = draggedHostId ?? event.dataTransfer.getData('application/x-spotshell-host-id')
    const host = savedHosts.get(hostId)
    setDropFolderId(null)
    if (host) {
      const resolution = resolveHostDropTarget(tree, { kind: 'folder', folderId: folder.id }, host.folderId)
      if (resolution.valid && resolution.changed) void move(host.id, resolution.folderId).catch(() => undefined)
    }
  }

  const renderEditor = (depth: number): JSX.Element | null => {
    if (!edit) return null
    return (
      <li className={'host-tree-item host-folder-edit-item'} role={'none'}>
        <div className={'host-folder-row'} style={{ paddingLeft: (depth - 1) * 14 }}>
          <span className={'host-folder-toggle'} aria-hidden={true} />
          <Folder size={15} className={'host-folder-icon'} aria-hidden={true} />
          <input autoFocus className={'host-folder-input'} value={edit.name} maxLength={MAX_FOLDER_NAME_LENGTH}
            aria-label={t('folderName')} aria-invalid={Boolean(edit.error)}
            onChange={(event) => {
              delete event.currentTarget.dataset.editHandled
              setEdit({ ...edit, name: event.target.value, error: undefined })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.dataset.editHandled = 'true'
                void submitEdit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.currentTarget.dataset.editHandled = 'true'
                setEdit(null)
              }
            }} onBlur={(event) => {
              if (event.currentTarget.dataset.editHandled !== 'true') void submitEdit()
            }} />
        </div>
        {edit.error ? <span className={'host-tree-inline-error'} role={'alert'}>{edit.error}</span> : null}
      </li>
    )
  }

  const renderFolder = (folder: HostTreeFolderNode, depth: number): JSX.Element => {
    const expanded = expandedIds.has(folder.id)
    const hasChildren = folder.folders.length > 0 || folder.hosts.length > 0 ||
      (edit?.mode === 'create' && edit.parentId === folder.id)
    const renaming = edit?.mode === 'rename' && edit.folderId === folder.id
    return (
      <li key={folder.id} className={'host-tree-item'} role={'none'}>
        <div role={'treeitem'} tabIndex={0} aria-level={depth} aria-expanded={hasChildren ? expanded : undefined}
          className={`host-folder-row${dropFolderId === folder.id ? ' host-tree-drop-target' : ''}`}
          style={{ paddingLeft: (depth - 1) * 14 }}
          onClick={() => toggleFolder(folder)} onContextMenu={(event) => openFolderMenu(folder, event)}
          onKeyDown={(event) => {
            moveTreeFocus(event, folder)
            if (event.target !== event.currentTarget) return
            if (event.key === 'Enter') {
              event.preventDefault()
              toggleFolder(folder)
            } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              const rect = event.currentTarget.getBoundingClientRect()
              event.preventDefault()
              setMenu({ kind: 'folder', folder, x: rect.left + 12, y: rect.bottom, returnFocusTo: event.currentTarget })
            }
          }} onDragOver={(event) => folderDragOver(event, folder)}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setDropFolderId(null)
              clearHoverTimer()
            }
          }} onDrop={(event) => folderDrop(event, folder)}>
          <span className={'host-folder-toggle'} aria-hidden={true}>
            {hasChildren ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
          </span>
          {expanded ? <FolderOpen size={15} className={'host-folder-icon'} aria-hidden={true} />
            : <Folder size={15} className={'host-folder-icon'} aria-hidden={true} />}
          {renaming ? (
            <input autoFocus className={'host-folder-input'} value={edit.name}
              maxLength={MAX_FOLDER_NAME_LENGTH} aria-label={t('folderName')} aria-invalid={Boolean(edit.error)}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                delete event.currentTarget.dataset.editHandled
                setEdit({ ...edit, name: event.target.value, error: undefined })
              }}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.dataset.editHandled = 'true'
                  void submitEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.currentTarget.dataset.editHandled = 'true'
                  setEdit(null)
                }
              }} onBlur={(event) => {
                if (event.currentTarget.dataset.editHandled !== 'true') void submitEdit()
              }} />
          ) : <span className={'host-folder-name'} title={folder.name}>{folder.name}</span>}
        </div>
        {renaming && edit.error ? <span className={'host-tree-inline-error'} role={'alert'}>{edit.error}</span> : null}
        {expanded ? (
          <ul className={'host-tree-group'} role={'group'}>
            {edit?.mode === 'create' && edit.parentId === folder.id ? renderEditor(depth + 1) : null}
            {folder.folders.map((child) => renderFolder(child, depth + 1))}
            {folder.hosts.map((profile) => {
              const host = savedHosts.get(profile.id)
              if (!host) return null
              const selected = props.selectedId === host.id
              const connecting = props.connectingHostIds?.has(host.id) ?? false
              const dragging = draggedHostId === host.id
              return (
                <li key={host.id} role={'none'} className={'host-tree-item'}>
                  <div role={'treeitem'} tabIndex={0} aria-level={depth + 1} aria-selected={selected}
                    draggable={movingHostId !== host.id}
                    className={`host-tree-host-row${selected ? ' selected' : ''}${dragging ? ' host-tree-dragging' : ''}`}
                    style={{ paddingLeft: depth * 14 }} title={`${host.name}\n${formatHostTarget(host)}`}
                    onClick={() => props.onSelect(host)} onDoubleClick={() => !connecting && props.onConnect(host)}
                    onKeyDown={(event) => {
                      moveTreeFocus(event)
                      if (event.target !== event.currentTarget) return
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        if (!connecting) props.onConnect(host)
                      } else if (event.key === ' ') {
                        event.preventDefault()
                        props.onSelect(host)
                      } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault()
                        const rect = event.currentTarget.getBoundingClientRect()
                        openHostMenu(host, rect.left + 12, rect.bottom, event.currentTarget)
                      }
                    }} onContextMenu={(event) => {
                      event.preventDefault()
                      openHostMenu(host, event.clientX, event.clientY, event.currentTarget)
                    }} onDragOver={(event) => {
                      event.stopPropagation()
                    }} onDrop={(event) => {
                      event.stopPropagation()
                    }} onDragStart={(event) => {
                      setDraggedHostId(host.id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('application/x-spotshell-host-id', host.id)
                      event.dataTransfer.setData('text/plain', host.name)
                    }} onDragEnd={() => {
                      setDraggedHostId(null)
                      setDropFolderId(null)
                      clearHoverTimer()
                    }}>
                    <span className={'host-tree-host-name'}>{host.name}</span>
                    <div className={'host-tree-host-actions'}>
                      <button type={'button'} className={'host-connect-button'} disabled={connecting}
                        onClick={(event) => { event.stopPropagation(); props.onConnect(host) }}>
                        {connecting ? t('connecting') : t('connect')}
                      </button>
                      <button type={'button'} className={'host-more-button'}
                        title={t('moreHostActions', { name: host.name })}
                        aria-label={t('moreHostActions', { name: host.name })} aria-haspopup={'menu'}
                        aria-expanded={menu?.kind === 'host' && menu.host.id === host.id}
                        onClick={(event) => {
                          event.stopPropagation()
                          const rect = event.currentTarget.getBoundingClientRect()
                          openHostMenu(host, rect.right, rect.bottom + 4, event.currentTarget)
                        }}><MoreHorizontal size={16} aria-hidden={true} /></button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <>
      <div ref={treeRef} className={'host-tree'} role={'tree'} aria-label={t('hosts')}
        onDragOver={(event) => {
          if (!draggedHostId) return
          event.preventDefault()
          setDropFolderId(ROOT_FOLDER_ID)
        }} onDrop={(event) => {
          event.preventDefault()
          const host = savedHosts.get(draggedHostId ?? '')
          setDropFolderId(null)
          if (host?.folderId) void move(host.id, undefined).catch(() => undefined)
        }}>
        <ul className={'host-tree-group host-tree-root'} role={'none'}>{renderFolder(visibleTree, 1)}</ul>
        {searchResult.isSearching && !searchResult.hasMatches ? (
          <div className={'host-list-empty'}><p className={'muted'}>{t('noHostsMatch')}</p>
            <button type={'button'} className={'btn btn-ghost btn-sm'} onClick={props.onClearSearch}>
              {t('clearHostSearch')}
            </button></div>
        ) : props.snapshot.hosts.length === 0 && props.snapshot.folders.length === 0 ? (
          <div className={'host-list-empty'}><p className={'muted'}>{t('noHosts')}</p>
            <button type={'button'} className={'btn btn-primary btn-sm'} onClick={() => props.onAddHost()}>
              {t('addFirstHost')}
            </button></div>
        ) : null}
      </div>
      {menu?.kind === 'folder' ? (
        <FolderContextMenu folder={menu.folder} x={menu.x} y={menu.y} returnFocusTo={menu.returnFocusTo}
          onClose={() => setMenu(null)}
          onRename={() => setEdit({ mode: 'rename', folderId: menu.folder.id, name: menu.folder.name })}
          onCreateFolder={() => {
            setExpanded(menu.folder.id, true)
            setEdit({ mode: 'create', parentId: menu.folder.id, name: '' })
          }} onCreateHost={() => props.onAddHost(menu.folder.isRoot ? undefined : menu.folder.id)}
          onDelete={() => setDeleteFolder(menu.folder)} />
      ) : null}
      {menu?.kind === 'host' ? (
        <HostContextMenu host={menu.host} x={menu.x} y={menu.y} returnFocusTo={menu.returnFocusTo}
          testing={props.testingHostId === menu.host.id}
          connecting={props.connectingHostIds?.has(menu.host.id)} testDisabled={Boolean(props.testingHostId)}
          onClose={() => setMenu(null)} onConnect={() => props.onConnect(menu.host)}
          onTest={() => props.onTestHost(menu.host)} onEdit={() => props.onEditHost(menu.host)}
          onMove={() => setMoveHost(menu.host)} onDelete={() => props.onRequestDeleteHost(menu.host)} />
      ) : null}
      <ConfirmDeleteFolderModal folder={deleteFolder}
        parentName={deleteFolder
          ? getHostTreeFolderPath(tree, deleteFolder.id).at(-2)?.name ?? t('mainFolder')
          : t('mainFolder')}
        onCancel={() => setDeleteFolder(null)}
        onConfirm={props.onRemoveFolder} />
      <MoveHostModal host={moveHost} tree={tree} onCancel={() => setMoveHost(null)} onConfirm={move} />
    </>
  )
}
