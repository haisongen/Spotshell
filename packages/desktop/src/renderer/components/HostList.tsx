import { Search, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { HostFolder, SavedHostProfile } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'
import { HostTree } from './HostTree'

export interface HostListProps {
  hosts: SavedHostProfile[]
  folders: HostFolder[]
  selectedId: string | null
  testingHostId?: string | null
  connectingHostIds?: ReadonlySet<string>
  onSelect: (host: SavedHostProfile) => void
  onConnect: (host: SavedHostProfile) => void
  onAdd: (folderId?: string) => void
  onEdit: (host: SavedHostProfile) => void
  onTest: (host: SavedHostProfile) => void
  onRequestDelete: (host: SavedHostProfile) => void
  onAddFolder: (parentId: string | undefined, name: string) => Promise<HostFolder | void>
  onRenameFolder: (id: string, name: string) => Promise<void>
  onRemoveFolder: (folder: HostFolder) => Promise<void>
  onMoveHost: (hostId: string, folderId?: string) => Promise<void>
}

export function HostList(props: HostListProps): JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const clearSearch = (): void => {
    setQuery('')
    searchRef.current?.focus()
  }
  return (
    <div className={'host-browser'}>
      <div className={'host-search'}>
        <Search size={14} aria-hidden={true} />
        <input ref={searchRef} type={'search'} value={query} placeholder={t('searchHosts')}
          aria-label={t('searchHosts')} onChange={(event) => setQuery(event.target.value)} />
        {query ? (
          <button type={'button'} className={'host-search-clear'} title={t('clearHostSearch')}
            aria-label={t('clearHostSearch')} onClick={clearSearch}>
            <X size={14} aria-hidden={true} />
          </button>
        ) : null}
      </div>
      <HostTree snapshot={{ hosts: props.hosts, folders: props.folders }} query={query}
        selectedId={props.selectedId} testingHostId={props.testingHostId}
        connectingHostIds={props.connectingHostIds} onSelect={props.onSelect}
        onConnect={props.onConnect} onAddHost={props.onAdd} onEditHost={props.onEdit}
        onTestHost={props.onTest} onRequestDeleteHost={props.onRequestDelete}
        onAddFolder={props.onAddFolder} onRenameFolder={props.onRenameFolder}
        onRemoveFolder={props.onRemoveFolder} onMoveHost={props.onMoveHost}
        onClearSearch={clearSearch} />
    </div>
  )
}
