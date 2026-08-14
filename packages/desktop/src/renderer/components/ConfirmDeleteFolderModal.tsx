import { useEffect, useRef, useState } from 'react'
import type { HostFolder } from '../../shared/ipc-types'
import type { HostTreeFolderNode } from '../hostTree'
import { useTranslation } from '../i18n'

interface ConfirmDeleteFolderModalProps {
  folder: HostTreeFolderNode | null
  parentName: string
  onCancel: () => void
  onConfirm: (folder: HostFolder) => Promise<void>
}

export function ConfirmDeleteFolderModal(props: ConfirmDeleteFolderModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!props.folder) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    requestAnimationFrame(() => cancelRef.current?.focus())
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
    }
  }, [props.folder?.id])

  useEffect(() => {
    if (!props.folder) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) props.onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [props.folder, props.onCancel, busy])

  if (!props.folder?.folder) return null
  const folder = props.folder
  const empty = folder.folders.length === 0 && folder.hosts.length === 0
  const confirm = async (): Promise<void> => {
    setBusy(true)
    try {
      await props.onConfirm(folder.folder!)
      props.onCancel()
    } catch {
      // App reports the IPC failure in the existing host sidebar error region.
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={'modal-backdrop delete-folder-backdrop'} onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) props.onCancel()
    }}>
      <section className={'modal delete-folder-modal'} role={'alertdialog'} aria-modal={true}
        aria-labelledby={'delete-folder-title'} aria-describedby={'delete-folder-description'}>
        <div className={'modal-header'}><h2 id={'delete-folder-title'}>{t('confirmDeleteFolder')}</h2></div>
        <div className={'modal-body'}>
          <p id={'delete-folder-description'}>
            {empty
              ? t('deleteEmptyFolderMessage', { name: folder.name })
              : t('deleteNonEmptyFolderMessage', {
                name: folder.name,
                hostCount: folder.hosts.length,
                folderCount: folder.folders.length,
                parent: props.parentName,
              })}
          </p>
          <div className={'modal-actions'}>
            <button ref={cancelRef} type={'button'} className={'btn btn-ghost'} disabled={busy}
              onClick={props.onCancel}>{t('cancel')}</button>
            <button type={'button'} className={'btn btn-danger'} disabled={busy}
              onClick={() => void confirm()}>{busy ? t('deleting') : t('delete')}</button>
          </div>
        </div>
      </section>
    </div>
  )
}
