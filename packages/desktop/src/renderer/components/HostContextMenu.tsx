import { CirclePlay, FolderInput, Pencil, PlugZap, Trash2 } from 'lucide-react'
import type { SavedHostProfile } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'
import { ContextMenuSurface } from './ContextMenuSurface'

interface HostContextMenuProps {
  host: SavedHostProfile
  x: number
  y: number
  returnFocusTo?: HTMLElement | null
  testing?: boolean
  connecting?: boolean
  testDisabled?: boolean
  onClose: () => void
  onConnect: () => void
  onTest: () => void
  onEdit: () => void
  onMove: () => void
  onDelete: () => void
}

export function HostContextMenu(props: HostContextMenuProps): JSX.Element {
  const { t } = useTranslation()
  const run = (action: () => void): void => {
    props.onClose()
    action()
  }

  return (
    <ContextMenuSurface x={props.x} y={props.y} returnFocusTo={props.returnFocusTo}
      onClose={props.onClose} label={t('moreHostActions', { name: props.host.name })}>
      <button type={'button'} role={'menuitem'} disabled={props.connecting}
        onClick={() => run(props.onConnect)}>
        <PlugZap size={15} aria-hidden={true} />
        <span>{props.connecting ? t('connecting') : t('connect')}</span>
      </button>
      <button type={'button'} role={'menuitem'} disabled={props.testDisabled}
        onClick={() => run(props.onTest)}>
        <CirclePlay size={15} aria-hidden={true} />
        <span>{props.testing ? t('testingHostConnection') : t('testHostConnection')}</span>
      </button>
      <button type={'button'} role={'menuitem'} onClick={() => run(props.onEdit)}>
        <Pencil size={15} aria-hidden={true} /><span>{t('editHost')}</span>
      </button>
      <button type={'button'} role={'menuitem'} onClick={() => run(props.onMove)}>
        <FolderInput size={15} aria-hidden={true} /><span>{t('moveToFolder')}</span>
      </button>
      <div className={'host-context-menu-separator'} role={'separator'} />
      <button type={'button'} role={'menuitem'}
        className={'host-context-menu-destructive'} onClick={() => run(props.onDelete)}>
        <Trash2 size={15} aria-hidden={true} /><span>{t('delete')}</span>
      </button>
    </ContextMenuSurface>
  )
}
