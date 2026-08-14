import { Folder, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SavedHostProfile } from '../../shared/ipc-types'
import { ROOT_FOLDER_ID, type HostTreeFolderNode } from '../hostTree'
import { useTranslation } from '../i18n'

interface MoveHostModalProps {
  host: SavedHostProfile | null
  tree: HostTreeFolderNode
  onCancel: () => void
  onConfirm: (hostId: string, folderId?: string) => Promise<void>
}

interface FolderChoice {
  id: string
  name: string
  depth: number
}

export function MoveHostModal(props: MoveHostModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(ROOT_FOLDER_ID)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const choices = useMemo(() => {
    const result: FolderChoice[] = []
    const visit = (folder: HostTreeFolderNode, depth: number): void => {
      result.push({ id: folder.id, name: folder.name, depth })
      folder.folders.forEach((child) => visit(child, depth + 1))
    }
    visit(props.tree, 0)
    const normalized = query.trim().toLocaleLowerCase()
    return normalized
      ? result.filter((folder) => folder.name.toLocaleLowerCase().includes(normalized))
      : result
  }, [props.tree, query])

  useEffect(() => {
    if (!props.host) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setSelectedId(props.host.folderId ?? ROOT_FOLDER_ID)
    busyRef.current = false
    setBusy(false)
    requestAnimationFrame(() => searchRef.current?.focus())
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
    }
  }, [props.host?.id])

  useEffect(() => {
    if (!props.host) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busyRef.current) props.onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [props.host, props.onCancel])

  if (!props.host) return null
  const currentId = props.host.folderId ?? ROOT_FOLDER_ID
  const moveTo = async (folderId: string): Promise<void> => {
    if (busyRef.current || folderId === currentId) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onConfirm(props.host!.id, folderId === ROOT_FOLDER_ID ? undefined : folderId)
      props.onCancel()
    } catch {
      // Keep the dialog open; App reports the IPC failure in the host sidebar.
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const onChoiceKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void moveTo(choices[index].id)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const next = event.key === 'ArrowDown'
      ? Math.min(index + 1, choices.length - 1)
      : Math.max(index - 1, 0)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }
  return (
    <div className={'modal-backdrop move-host-backdrop'} onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busyRef.current) props.onCancel()
    }}>
      <section className={'modal move-host-modal'} role={'dialog'} aria-modal={true}
        aria-labelledby={'move-host-title'}>
        <div className={'modal-header'}>
          <h2 id={'move-host-title'}>{t('moveHostTitle', { name: props.host.name })}</h2>
        </div>
        <div className={'modal-body'}>
          <div className={'host-search move-folder-search'}>
            <Search size={14} aria-hidden={true} />
            <input ref={searchRef} type={'search'} value={query} aria-label={t('searchFolders')}
              placeholder={t('searchFolders')} onChange={(event) => setQuery(event.target.value)} />
            {query ? <button type={'button'} className={'host-search-clear'}
              aria-label={t('clearFolderSearch')} onClick={() => setQuery('')}>
              <X size={14} aria-hidden={true} />
            </button> : null}
          </div>
          <div className={'move-folder-list'} role={'listbox'} aria-label={t('moveToFolder')}>
            {choices.map((folder, index) => (
              <button key={folder.id} type={'button'} role={'option'}
                aria-selected={selectedId === folder.id} className={selectedId === folder.id ? 'selected' : ''}
                style={{ paddingLeft: 10 + folder.depth * 14 }}
                onClick={() => setSelectedId(folder.id)} onDoubleClick={() => {
                  setSelectedId(folder.id)
                  void moveTo(folder.id)
                }} onKeyDown={(event) => onChoiceKeyDown(event, index)}>
                <Folder size={15} aria-hidden={true} /><span>{folder.name}</span>
                {folder.id === currentId ? <span className={'muted'}>{t('currentFolder')}</span> : null}
              </button>
            ))}
            {choices.length === 0 ? (
              <p className={'muted'} role={'status'}>{t('noFoldersMatch')}</p>
            ) : null}
          </div>
          <div className={'modal-actions'}>
            <button type={'button'} className={'btn btn-ghost'} disabled={busy}
              onClick={props.onCancel}>{t('cancel')}</button>
            <button type={'button'} className={'btn btn-primary'} disabled={busy || selectedId === currentId}
              onClick={() => void moveTo(selectedId)}>{t('moveHere')}</button>
          </div>
        </div>
      </section>
    </div>
  )
}
