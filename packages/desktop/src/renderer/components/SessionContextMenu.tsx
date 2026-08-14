import { Copy, Pencil, XCircle } from 'lucide-react'
import { useTranslation } from '../i18n'
import { ContextMenuSurface } from './ContextMenuSurface'

export interface SessionContextMenuTarget {
  sessionId: string
  x: number
  y: number
  returnFocusTo: HTMLElement | null
}

interface SessionContextMenuProps {
  target: SessionContextMenuTarget
  canCloseOthers: boolean
  onClose: () => void
  onRename: (sessionId: string) => void
  onDuplicate: (sessionId: string) => void
  onCloseOthers: (sessionId: string) => void
}

export function SessionContextMenu(props: SessionContextMenuProps): JSX.Element {
  const { t } = useTranslation()
  const run = (action: (sessionId: string) => void): void => {
    props.onClose()
    action(props.target.sessionId)
  }

  return (
    <ContextMenuSurface
      x={props.target.x}
      y={props.target.y}
      label={t('sessionActions')}
      returnFocusTo={props.target.returnFocusTo}
      onClose={props.onClose}
    >
      <button type="button" role="menuitem" onClick={() => run(props.onRename)}>
        <Pencil size={15} aria-hidden />
        <span>{t('renameSession')}</span>
      </button>
      <button type="button" role="menuitem" onClick={() => run(props.onDuplicate)}>
        <Copy size={15} aria-hidden />
        <span>{t('duplicateSession')}</span>
      </button>
      <div className="host-context-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="host-context-menu-destructive"
        disabled={!props.canCloseOthers}
        onClick={() => run(props.onCloseOthers)}
      >
        <XCircle size={15} aria-hidden />
        <span>{t('closeOtherSessions')}</span>
      </button>
    </ContextMenuSurface>
  )
}
