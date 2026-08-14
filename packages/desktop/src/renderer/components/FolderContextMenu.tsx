import { FolderPlus, Pencil, PlugZap, Trash2 } from 'lucide-react'
import type { HostTreeFolderNode } from '../hostTree'
import { useTranslation } from '../i18n'
import { ContextMenuSurface } from './ContextMenuSurface'

interface FolderContextMenuProps {
  folder: HostTreeFolderNode
  x: number
  y: number
  returnFocusTo?: HTMLElement | null
  onClose: () => void
  onRename: () => void
  onCreateFolder: () => void
  onCreateHost: () => void
  onDelete: () => void
}

export function FolderContextMenu(props: FolderContextMenuProps): JSX.Element {
  const { t } = useTranslation()
  const run = (action: () => void): void => {
    props.onClose()
    action()
  }
  return (
    <ContextMenuSurface x={props.x} y={props.y} returnFocusTo={props.returnFocusTo}
      onClose={props.onClose} label={t('folderActions', { name: props.folder.name })}>
      {!props.folder.isRoot ? (
        <button type={'button'} role={'menuitem'} onClick={() => run(props.onRename)}>
          <Pencil size={15} aria-hidden={true} /><span>{t('renameFolder')}</span>
        </button>
      ) : null}
      <button type={'button'} role={'menuitem'} onClick={() => run(props.onCreateFolder)}>
        <FolderPlus size={15} aria-hidden={true} /><span>{t('newFolder')}</span>
      </button>
      <button type={'button'} role={'menuitem'} onClick={() => run(props.onCreateHost)}>
        <PlugZap size={15} aria-hidden={true} /><span>{t('newHost')}</span>
      </button>
      {!props.folder.isRoot ? <div className={'host-context-menu-separator'} role={'separator'} /> : null}
      {!props.folder.isRoot ? (
        <button type={'button'} role={'menuitem'} className={'host-context-menu-destructive'}
          onClick={() => run(props.onDelete)}>
          <Trash2 size={15} aria-hidden={true} /><span>{t('delete')}</span>
        </button>
      ) : null}
    </ContextMenuSurface>
  )
}
