import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type {
  AppSettings,
  ConnectRequest,
  ExecPolicy,
  EnvironmentSummary,
  KnowledgeModuleAccessSummary,
  HostVerifyRequest,
  HostConnectionTestDraft,
  HostConnectionTestResult,
  HostFolder,
  SavedHostInput,
  SavedHostProfile,
} from '../shared/ipc-types'
import { Plus } from 'lucide-react'
import { HostList } from './components/HostList'
import { HostEditorModal, type HostEditorMode } from './components/HostEditorModal'
import { ConfirmDeleteHostModal } from './components/ConfirmDeleteHostModal'
import {
  ConfirmCloseSessionModal,
  type CloseSessionTarget,
} from './components/ConfirmCloseSessionModal'
import { SettingsModal } from './components/SettingsModal'
import { SessionTabs } from './components/SessionTabs'
import {
  SessionContextMenu,
  type SessionContextMenuTarget,
} from './components/SessionContextMenu'
import {
  RenameSessionModal,
  type RenameSessionTarget,
} from './components/RenameSessionModal'
import { ConfirmCloseOtherSessionsModal } from './components/ConfirmCloseOtherSessionsModal'
import { TerminalStack } from './components/TerminalStack'
import { ChatPanel } from './components/ChatPanel'
import { QuickConnectForm } from './components/QuickConnectForm'
import { ConnectionModal } from './components/ConnectionModal'
import { HostVerifyDialog } from './components/HostVerifyDialog'
import { HostNotesEditor } from './components/HostNotesEditor'
import { AppNoticeBanner, type AppNotice } from './components/AppNoticeBanner'
import { AppTitleBar } from './components/AppTitleBar'
import { KnowledgeWorkspace } from './components/KnowledgeWorkspace'
import { useSessions } from './hooks/useSessions'
import { useTranslation } from './i18n'
import { closeMatchingHostVerify } from './hostVerifyState'
import { getNextTheme } from './theme'
import {
  createCloseOtherSessionsSnapshot,
  type CloseOtherSessionsSnapshot,
} from './sessionTabActions'

const MIN_RAIL_WIDTH = 240
const MAX_RAIL_WIDTH = 480
const MIN_CHAT_WIDTH = 280
const MAX_CHAT_WIDTH = 1000

function needsPassword(host: SavedHostProfile): boolean {
  if (host.hasPassword) return false
  if (host.authMethod === 'password') return true
  if (host.authMethod === 'key' || host.authMethod === 'agent') return false
  return !host.privateKeyPath
}

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, width))
}

function clampChatWidth(width: number): number {
  return Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, width))
}

/** Skip Ctrl+W only for real form/AI fields — xterm uses a helper textarea that should still close tabs. */
function shouldIgnoreCloseShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.terminal-view') || target.classList.contains('xterm-helper-textarea')) {
    return false
  }
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

export function App(): JSX.Element {
  const { t } = useTranslation()
  const [activeWorkspace, setActiveWorkspace] = useState<'terminal' | 'knowledge'>('terminal')
  const [hosts, setHosts] = useState<SavedHostProfile[] | null>(null)
  const [folders, setFolders] = useState<HostFolder[]>([])
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([])
  const [knowledgeModules, setKnowledgeModules] = useState<KnowledgeModuleAccessSummary[]>([])
  const [knowledgeTarget, setKnowledgeTarget] = useState<{
    section: 'environments' | 'modules'
    id: string
    nonce: number
  } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formBusy, setFormBusy] = useState(false)
  const [hostEditorOpen, setHostEditorOpen] = useState(false)
  const [hostEditorMode, setHostEditorMode] = useState<HostEditorMode>('create')
  const [editingHost, setEditingHost] = useState<SavedHostProfile | null>(null)
  const [createHostFolderId, setCreateHostFolderId] = useState<string | undefined>()
  const [pendingDeleteHost, setPendingDeleteHost] = useState<SavedHostProfile | null>(null)
  const [pendingCloseSession, setPendingCloseSession] = useState<CloseSessionTarget | null>(null)
  const [sessionMenu, setSessionMenu] = useState<SessionContextMenuTarget | null>(null)
  const [renameSessionTarget, setRenameSessionTarget] = useState<RenameSessionTarget | null>(null)
  const [closeOthersSnapshot, setCloseOthersSnapshot] = useState<CloseOtherSessionsSnapshot | null>(null)
  const [closingOtherSessions, setClosingOtherSessions] = useState(false)
  const [deletingHostId, setDeletingHostId] = useState<string | null>(null)
  const [testingHostId, setTestingHostId] = useState<string | null>(null)
  const [chatPendingCount, setChatPendingCount] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [themeSaving, setThemeSaving] = useState(false)
  const settingsLoadVersionRef = useRef(0)
  const [notice, setNotice] = useState<AppNotice | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [connectionHost, setConnectionHost] = useState<SavedHostProfile | null>(null)
  const [connectingHostIds, setConnectingHostIds] = useState<Set<string>>(new Set())
  const connectingHostIdsRef = useRef(new Set<string>())
  const [hostVerify, setHostVerify] = useState<HostVerifyRequest | null>(null)
  const [railWidth, setRailWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('spotshell.railWidth'))
    return Number.isFinite(saved) && saved > 0 ? clampRailWidth(saved) : 300
  })
  const [railCollapsed, setRailCollapsed] = useState(
    () => window.localStorage.getItem('spotshell.railCollapsed') === 'true'
  )
  const [resizingRail, setResizingRail] = useState(false)
  const railResizeRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('spotshell.chatWidth'))
    return Number.isFinite(saved) && saved > 0 ? clampChatWidth(saved) : 360
  })
  const [chatCollapsed, setChatCollapsed] = useState(
    () => window.localStorage.getItem('spotshell.chatCollapsed') === 'true'
  )
  const [chatPrefill, setChatPrefill] = useState<{ text: string; nonce: number } | null>(null)
  const [resizingChat, setResizingChat] = useState(false)
  const chatResizeRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)

  const {
    sessions,
    activeSessionId,
    setActiveSessionId,
    connect,
    reconnect,
    close,
    rename,
    duplicate,
    closeMany,
    cycleActive,
    reconnectingSessionIds,
    error: sessionError,
    clearError: clearSessionError,
  } = useSessions()

  useEffect(() => {
    if (sessionMenu && !sessions.some((session) => session.id === sessionMenu.sessionId)) {
      setSessionMenu(null)
    }
  }, [sessions, sessionMenu])

  useEffect(() => {
    if (renameSessionTarget && !sessions.some((session) => session.id === renameSessionTarget.id)) {
      setRenameSessionTarget(null)
    }
    if (closeOthersSnapshot && !sessions.some(
      (session) => session.id === closeOthersSnapshot.keepSessionId
    )) {
      setCloseOthersSnapshot(null)
    }
  }, [sessions, renameSessionTarget, closeOthersSnapshot])
  const busyHostIds = new Set(connectingHostIds)
  for (const session of sessions) {
    if (session.status === 'connecting' && session.hostId) busyHostIds.add(session.hostId)
  }

  const refreshHosts = useCallback(async () => {
    const tree = await window.spotshell.getHostTree()
    setHosts(tree.hosts)
    setFolders(tree.folders)
    setSelectedId((current) =>
      current && tree.hosts.some((host) => host.id === current) ? current : null
    )
    setError(null)
    return tree.hosts
  }, [])

  useEffect(() => {
    if (activeWorkspace !== 'terminal') return
    let cancelled = false
    Promise.all([window.spotshell.listEnvironments(), window.spotshell.listKnowledgeModules()])
      .then(([environmentItems, moduleItems]) => {
        if (!cancelled) {
          setEnvironments(environmentItems)
          setKnowledgeModules(moduleItems)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err)
          setNotice({ tone: 'error', message: t('environmentListLoadFailed', { message }) })
        }
      })
    return () => { cancelled = true }
  }, [activeWorkspace, t])

  useEffect(() => {
    let cancelled = false
    const loadVersion = settingsLoadVersionRef.current

    Promise.all([window.spotshell.getHostTree(), window.spotshell.getSettings()])
      .then(([tree, s]) => {
        if (cancelled) return
        setHosts(tree.hosts)
        setFolders(tree.folders)
        if (settingsLoadVersionRef.current === loadVersion) setSettings(s)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError(t('hostTreeLoadFailed', { message }))
        setHosts([])
        setFolders([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return window.spotshell.onHostVerify((req) => setHostVerify(req))
  }, [t])

  const activeTheme = settings?.theme ?? 'dark'

  useEffect(() => {
    const root = document.documentElement
    if (settings) {
      root.dataset.theme = settings.theme
    } else {
      delete root.dataset.theme
    }
  }, [settings])

  async function handleThemeToggle(): Promise<void> {
    if (themeSaving) return
    settingsLoadVersionRef.current += 1
    setThemeSaving(true)
    setNotice(null)
    let current = settings
    try {
      current ??= await window.spotshell.getSettings()
      const next = await window.spotshell.setSettings({ theme: getNextTheme(current.theme) })
      setSettings(next)
    } catch (err: unknown) {
      if (!settings && current) setSettings(current)
      const message = err instanceof Error ? err.message : String(err)
      setNotice({ tone: 'error', message: t('themeChangeFailed', { message }) })
    } finally {
      setThemeSaving(false)
    }
  }

  useEffect(() => {
    return window.spotshell.onHostVerifyClosed((event) => {
      setHostVerify((current) => closeMatchingHostVerify(current, event))
    })
  }, [])

  function handleHostVerifyRespond(ok: boolean): void {
    if (!hostVerify) return
    window.spotshell.respondHostVerify(hostVerify.requestId, ok)
    setHostVerify(null)
  }

  function openAddHost(folderId?: string): void {
    setEditingHost(null)
    setCreateHostFolderId(folderId)
    setHostEditorMode('create')
    setHostEditorOpen(true)
  }

  function openEditHost(host: SavedHostProfile): void {
    setEditingHost(host)
    setCreateHostFolderId(undefined)
    setHostEditorMode('edit')
    setHostEditorOpen(true)
  }

  async function handleAddHost(input: SavedHostInput): Promise<void> {
    setFormBusy(true)
    setNotice(null)
    try {
      const created = await window.spotshell.addHost(input)
      const list = await refreshHosts()
      setSelectedId(created.id)
      if (!list.find((h) => h.id === created.id)) {
        setSelectedId(null)
      }
    } finally {
      setFormBusy(false)
    }
  }

  async function runHostTreeMutation<T>(
    operation: () => Promise<T>,
    formatFailure: (message: string) => string
  ): Promise<T> {
    setError(null)
    try {
      return await operation()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const failure = new Error(formatFailure(message))
      setError(failure.message)
      throw failure
    }
  }

  async function handleAddFolder(parentId: string | undefined, name: string): Promise<HostFolder> {
    return runHostTreeMutation(
      async () => {
        const folder = await window.spotshell.addHostFolder({ name, parentId })
        await refreshHosts()
        return folder
      },
      (message) => t('createFolderFailed', { message })
    )
  }

  async function handleRenameFolder(id: string, name: string): Promise<void> {
    await runHostTreeMutation(
      async () => {
        await window.spotshell.renameHostFolder({ id, name })
        await refreshHosts()
      },
      (message) => t('renameFolderFailed', { message })
    )
  }

  async function handleRemoveFolder(folder: HostFolder): Promise<void> {
    await runHostTreeMutation(
      async () => {
        await window.spotshell.removeHostFolder({ id: folder.id })
        await refreshHosts()
      },
      (message) =>
        message.toLocaleLowerCase().includes('already exists')
          ? t('deleteFolderConflict')
          : t('deleteFolderFailed', { message })
    )
  }

  async function handleMoveHost(hostId: string, folderId?: string): Promise<void> {
    await runHostTreeMutation(
      async () => {
        await window.spotshell.moveHost({ hostId, folderId })
        await refreshHosts()
        setSelectedId(hostId)
      },
      (message) => t('moveHostFailed', { message })
    )
  }

  async function handleUpdateHost(input: SavedHostInput): Promise<void> {
    if (!editingHost) throw new Error('No host selected for editing')
    setFormBusy(true)
    setNotice(null)
    try {
      const updated = await window.spotshell.updateHost(editingHost.id, input)
      await refreshHosts()
      setSelectedId(updated.id)
    } finally {
      setFormBusy(false)
    }
  }

  async function handleRemoveHost(host: SavedHostProfile): Promise<void> {
    setDeletingHostId(host.id)
    setNotice(null)
    try {
      await window.spotshell.removeHost(host.id)
      if (selectedId === host.id) setSelectedId(null)
      await refreshHosts()
      setPendingDeleteHost(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingHostId(null)
    }
  }

  async function handleTestHost(host: SavedHostProfile): Promise<void> {
    if (testingHostId) return
    setTestingHostId(host.id)
    setNotice(null)
    try {
      const result = await window.spotshell.testHostConnection({ hostId: host.id })
      setNotice({
        tone: result.ok ? 'success' : 'error',
        message: result.ok
          ? t('testHostConnectionSuccess', { name: host.name, latencyMs: result.latencyMs })
          : t('testHostConnectionFailed', { name: host.name, message: result.message }),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setNotice({
        tone: 'error',
        message: t('testHostConnectionFailed', { name: host.name, message }),
      })
    } finally {
      setTestingHostId(null)
    }
  }

  async function handleTestHostDraft(
    draft: HostConnectionTestDraft
  ): Promise<HostConnectionTestResult> {
    if (!editingHost) throw new Error('No host selected for testing')
    if (testingHostId) throw new Error('A connection test is already running')
    setTestingHostId(editingHost.id)
    try {
      return await window.spotshell.testHostConnection({ hostId: editingHost.id, draft })
    } finally {
      setTestingHostId(null)
    }
  }

  async function handleConnect(host: SavedHostProfile): Promise<void> {
    setNotice(null)
    clearSessionError()

    if (needsPassword(host)) {
      setConnectionHost(host)
      setConnectionOpen(true)
      return
    }

    if (!beginHostConnection(host.id)) return

    try {
      await connect({
        hostId: host.id,
        host: host.host,
        port: host.port,
        username: host.username,
        privateKeyPath: host.authMethod === 'key' ? host.privateKeyPath : undefined,
        useAgent: host.authMethod === 'agent',
        title: host.name || `${host.username}@${host.host}`,
      })
      setSelectedId(host.id)
      setNotice(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setNotice({ tone: 'error', message: t('connectFailed', { message }) })
    } finally {
      endHostConnection(host.id)
    }
  }

  function beginHostConnection(hostId: string): boolean {
    if (connectingHostIdsRef.current.has(hostId)) return false
    connectingHostIdsRef.current.add(hostId)
    setConnectingHostIds(new Set(connectingHostIdsRef.current))
    return true
  }

  function endHostConnection(hostId: string): void {
    connectingHostIdsRef.current.delete(hostId)
    setConnectingHostIds(new Set(connectingHostIdsRef.current))
  }

  async function handleQuickConnect(req: ConnectRequest): Promise<void> {
    setNotice(null)
    clearSessionError()
    try {
      await connect(req)
      setNotice(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setNotice({ tone: 'error', message: t('connectFailed', { message }) })
      throw err instanceof Error ? err : new Error(message)
    }
  }

  async function handleModalConnect(req: ConnectRequest): Promise<void> {
    const hostId = req.hostId
    if (hostId && !beginHostConnection(hostId)) return
    try {
      await handleQuickConnect(req)
      if (hostId) setSelectedId(hostId)
    } finally {
      if (hostId) endHostConnection(hostId)
    }
  }

  async function handleReconnect(sessionId: string): Promise<void> {
    if (reconnectingSessionIds.has(sessionId)) return
    setNotice(null)
    clearSessionError()
    try {
      await reconnect(sessionId)
      setNotice(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setNotice({ tone: 'error', message: t('reconnectFailed', { message }) })
    }
  }

  async function handleCloseSession(sessionId: string): Promise<void> {
    try {
      await close(sessionId)
    } catch (err: unknown) {
      setNotice({ tone: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleSelectEnvironment(
    sessionId: string,
    environmentId: string | undefined,
    persistForHost: boolean,
  ): Promise<void> {
    setNotice(null)
    try {
      await window.spotshell.selectSessionEnvironment({
        sessionId,
        environmentId,
        persistForHost,
      })
      if (persistForHost) await refreshHosts()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setNotice({ tone: 'error', message: t('environmentSelectionFailed', { message }) })
      throw err instanceof Error ? err : new Error(message)
    }
  }

  async function handleKnowledgeAction(
    action: 'load' | 'pin' | 'unpin' | 'unload',
    moduleId: string,
  ): Promise<void> {
    if (!activeSessionId) return
    const request = { sessionId: activeSessionId, moduleId }
    const operation = action === 'load'
      ? window.spotshell.loadSessionKnowledge
      : action === 'pin'
        ? window.spotshell.pinSessionKnowledge
        : action === 'unpin'
          ? window.spotshell.unpinSessionKnowledge
          : window.spotshell.unloadSessionKnowledge
    await operation(request)
  }

  async function handleApplyRevision(
    objectId: string,
    targetRevision: number,
    targetContentHash: string,
  ): Promise<void> {
    if (!activeSessionId) return
    await window.spotshell.applySessionRevision({
      sessionId: activeSessionId,
      objectId,
      targetRevision,
      targetContentHash,
    })
  }

  async function handleKeepRevision(
    objectId: string,
    latestRevision: number,
    latestContentHash: string,
  ): Promise<void> {
    if (!activeSessionId) return
    await window.spotshell.keepSessionRevision({
      sessionId: activeSessionId,
      objectId,
      latestRevision,
      latestContentHash,
    })
  }

  function openKnowledgeModule(moduleId?: string): void {
    if (moduleId) {
      setKnowledgeTarget({ section: 'modules', id: moduleId, nonce: Date.now() })
    }
    setActiveWorkspace('knowledge')
  }

  function openEnvironment(environmentId: string): void {
    setKnowledgeTarget({ section: 'environments', id: environmentId, nonce: Date.now() })
    setActiveWorkspace('knowledge')
  }

  async function handleRenameSession(sessionId: string, title: string): Promise<void> {
    await rename(sessionId, title)
    setRenameSessionTarget(null)
  }

  async function handleDuplicateSession(sessionId: string): Promise<void> {
    const source = sessions.find((session) => session.id === sessionId)
    if (!source) return
    try {
      await duplicate(sessionId, source.title)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setNotice({ tone: 'error', message: t('duplicateSessionFailed', { message }) })
    }
  }

  async function handleCloseOtherSessions(snapshot: CloseOtherSessionsSnapshot): Promise<void> {
    if (closingOtherSessions) return
    setClosingOtherSessions(true)
    try {
      await closeMany(snapshot.closeSessionIds, snapshot.keepSessionId)
      setCloseOthersSnapshot(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setNotice({ tone: 'error', message: t('closeOtherSessionsFailed', { message }) })
    } finally {
      setClosingOtherSessions(false)
    }
  }

  function updateRailWidth(width: number): void {
    const next = clampRailWidth(width)
    setRailWidth(next)
    window.localStorage.setItem('spotshell.railWidth', String(next))
  }

  function setRailPanelCollapsed(collapsed: boolean): void {
    setRailCollapsed(collapsed)
    window.localStorage.setItem('spotshell.railCollapsed', String(collapsed))
  }

  function handleRailPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    railResizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: railWidth,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setResizingRail(true)
  }

  function handleRailPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const resize = railResizeRef.current
    if (!resize || resize.pointerId !== e.pointerId) return
    updateRailWidth(resize.startWidth + e.clientX - resize.startX)
  }

  function handleRailPointerEnd(e: ReactPointerEvent<HTMLDivElement>): void {
    if (railResizeRef.current?.pointerId !== e.pointerId) return
    railResizeRef.current = null
    setResizingRail(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  function handleRailResizeKey(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    updateRailWidth(railWidth + (e.key === 'ArrowLeft' ? -16 : 16))
  }

  function updateChatWidth(width: number): void {
    const next = clampChatWidth(width)
    setChatWidth(next)
    window.localStorage.setItem('spotshell.chatWidth', String(next))
  }

  function setChatPanelCollapsed(collapsed: boolean): void {
    setChatCollapsed(collapsed)
    window.localStorage.setItem('spotshell.chatCollapsed', String(collapsed))
  }

  function handleChatPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    chatResizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: chatWidth,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setResizingChat(true)
  }

  function handleChatPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const resize = chatResizeRef.current
    if (!resize || resize.pointerId !== e.pointerId) return
    updateChatWidth(resize.startWidth - (e.clientX - resize.startX))
  }

  function handleChatPointerEnd(e: ReactPointerEvent<HTMLDivElement>): void {
    if (chatResizeRef.current?.pointerId !== e.pointerId) return
    chatResizeRef.current = null
    setResizingChat(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  function handleChatResizeKey(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    updateChatWidth(chatWidth + (e.key === 'ArrowLeft' ? 16 : -16))
  }

  // Keyboard: Ctrl+Tab / Ctrl+Shift+Tab cycle; Ctrl+W close active tab
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (activeWorkspace !== 'terminal') return
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return

      if (e.key === 'Tab' && sessions.length > 0) {
        e.preventDefault()
        cycleActive(e.shiftKey ? -1 : 1)
        return
      }

      if ((e.key === 'w' || e.key === 'W') && activeSessionId) {
        // Don't steal Ctrl+W from form/AI fields; still allow when focus is in xterm
        if (shouldIgnoreCloseShortcut(e.target)) return
        e.preventDefault()
        void handleCloseSession(activeSessionId)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // handleCloseSession is stable enough via close; include deps used
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspace, sessions.length, activeSessionId, cycleActive])

  const selected = hosts?.find((h) => h.id === selectedId) ?? null
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const showTerminal = sessions.length > 0
  const activeHasApiKey = settings
    ? settings.model.providers[settings.model.activeProvider].hasApiKey
    : false

  return (
    <div className="app-shell">
      <AppTitleBar
        hasApiKey={activeHasApiKey}
        theme={activeTheme}
        themeSaving={themeSaving}
        onToggleTheme={() => {
          void handleThemeToggle()
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onMenuError={(message) => {
          setNotice({ tone: 'error', message: t('menuOpenFailed', { message }) })
        }}
        activeWorkspace={activeWorkspace}
        onChangeWorkspace={setActiveWorkspace}
      />

      <div
        className={`app-body${resizingRail || resizingChat ? ' resizing' : ''}${
          resizingRail ? ' resizing-rail' : ''
        }${resizingChat ? ' resizing-chat' : ''}`}
        hidden={activeWorkspace !== 'terminal'}
      >
        <aside
          className={`left-rail${railCollapsed ? ' left-rail-hidden' : ''}`}
          style={{ width: railWidth, flexBasis: railWidth }}
          aria-hidden={railCollapsed}
        >
          <div className="rail-section">
            <div className="rail-heading">
              <h2>{t('hosts')}</h2>
              <div className="rail-heading-actions">
                <button
                  type="button"
                  className="rail-panel-toggle"
                  title={t('addHostTitle')}
                  aria-label={t('addHostTitle')}
                  onClick={() => openAddHost()}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="rail-panel-toggle"
                  title={t('collapseHosts')}
                  aria-label={t('collapseHosts')}
                  aria-expanded="true"
                  onClick={() => setRailPanelCollapsed(true)}
                >
                  <span aria-hidden>&lt;</span>
                </button>
              </div>
            </div>
            {error ? <p className="form-error">{error}</p> : null}
            {hosts === null ? (
              <p className="muted">{t('loadingHosts')}</p>
            ) : (
              <HostList
                hosts={hosts}
                folders={folders}
                selectedId={selectedId}
                testingHostId={testingHostId}
                connectingHostIds={busyHostIds}
                onSelect={(h) => setSelectedId(h.id)}
                onConnect={(h) => {
                  void handleConnect(h)
                }}
                onAdd={openAddHost}
                onAddFolder={handleAddFolder}
                onRenameFolder={handleRenameFolder}
                onRemoveFolder={handleRemoveFolder}
                onMoveHost={handleMoveHost}
                onEdit={openEditHost}
                onTest={(h) => {
                  void handleTestHost(h)
                }}
                onRequestDelete={setPendingDeleteHost}
              />
            )}
          </div>
        </aside>

        {railCollapsed ? (
          <aside className="left-rail-collapsed" aria-label={t('hostsCollapsed')}>
            <button
              type="button"
              className="rail-panel-toggle"
              title={t('expandHosts')}
              aria-label={t('expandHosts')}
              aria-expanded="false"
              onClick={() => setRailPanelCollapsed(false)}
            >
              <span aria-hidden>&gt;</span>
            </button>
          </aside>
        ) : (
          <div
            className="rail-resizer"
            role="separator"
            aria-label={t('resizeHosts')}
            aria-orientation="vertical"
            aria-valuemin={MIN_RAIL_WIDTH}
            aria-valuemax={MAX_RAIL_WIDTH}
            aria-valuenow={railWidth}
            tabIndex={0}
            onPointerDown={handleRailPointerDown}
            onPointerMove={handleRailPointerMove}
            onPointerUp={handleRailPointerEnd}
            onPointerCancel={handleRailPointerEnd}
            onKeyDown={handleRailResizeKey}
          />
        )}

        <main className={`main-pane${showTerminal ? ' main-pane-session' : ''}`}>
          {notice || sessionError ? (
            <div className="app-message-region">
              {notice ? (
                <AppNoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
              ) : null}
              {sessionError ? (
                <AppNoticeBanner
                  notice={{ tone: 'error', message: sessionError }}
                  onDismiss={clearSessionError}
                />
              ) : null}
            </div>
          ) : null}

          {showTerminal ? (
            <div className="session-workspace">
              <SessionTabs
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelect={setActiveSessionId}
                onClose={(id) => {
                  const session = sessions.find((candidate) => candidate.id === id)
                  if (session) setPendingCloseSession({ id: session.id, title: session.title })
                }}
                onContextMenu={setSessionMenu}
                onNew={() => {
                  setConnectionHost(null)
                  setConnectionOpen(true)
                }}
              />
              <TerminalStack
                theme={activeTheme}
                sessions={sessions}
                activeSessionId={activeSessionId}
                reconnectingSessionIds={reconnectingSessionIds}
                onReconnect={(id) => {
                  void handleReconnect(id)
                }}
                onClose={(id) => {
                  void handleCloseSession(id)
                }}
                onAskAi={(sessionId, text) => {
                  setActiveSessionId(sessionId)
                  setChatPrefill({ text, nonce: Date.now() })
                  setChatPanelCollapsed(false)
                }}
              />
            </div>
          ) : selected ? (
            <div className="empty-main">
              <h2>{selected.name}</h2>
              <p className="muted">
                {selected.username}@{selected.host}:{selected.port}
              </p>
              <p className="hint">{t('openTerminalHint')}</p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busyHostIds.has(selected.id)}
                onClick={() => {
                  void handleConnect(selected)
                }}
              >
                {busyHostIds.has(selected.id) ? t('connecting') : t('connect')}
              </button>
              <HostNotesEditor
                host={selected}
                onSaved={async () => {
                  await refreshHosts()
                }}
              />
              <div className="empty-divider">
                <span>{t('orQuickConnect')}</span>
              </div>
              <QuickConnectForm onConnect={handleQuickConnect} />
            </div>
          ) : (
            <div className="empty-main">
              <QuickConnectForm onConnect={handleQuickConnect} />
              <p className="hint empty-main-secondary">
                {t('savedHostHint')}
              </p>
            </div>
          )}
        </main>

        {chatCollapsed ? null : (
          <div
            className="chat-resizer"
            role="separator"
            aria-label={t('resizeChat')}
            aria-orientation="vertical"
            aria-valuemin={MIN_CHAT_WIDTH}
            aria-valuemax={MAX_CHAT_WIDTH}
            aria-valuenow={chatWidth}
            tabIndex={0}
            onPointerDown={handleChatPointerDown}
            onPointerMove={handleChatPointerMove}
            onPointerUp={handleChatPointerEnd}
            onPointerCancel={handleChatPointerEnd}
            onKeyDown={handleChatResizeKey}
          />
        )}
        <ChatPanel
          hidden={chatCollapsed}
          width={chatWidth}
          sessionId={activeSessionId}
          hasApiKey={activeHasApiKey}
          policy={activeSession?.policy ?? 'ask'}
          onChangePolicy={(policy: ExecPolicy) => {
            if (activeSessionId) window.spotshell.sessionSetPolicy(activeSessionId, policy)
          }}
          prefill={chatPrefill}
          onHostNotesSaved={() => { void refreshHosts() }}
          onPendingCountChange={setChatPendingCount}
          sessionReady={activeSession?.status === 'ready'}
          session={activeSession ?? null}
          environments={environments}
          modules={knowledgeModules}
          onEnvironmentSelect={(environmentId, persistForHost) => activeSessionId
            ? handleSelectEnvironment(activeSessionId, environmentId, persistForHost)
            : Promise.resolve()}
          onKnowledgeAction={handleKnowledgeAction}
          onApplyRevision={handleApplyRevision}
          onKeepRevision={handleKeepRevision}
          onManageKnowledge={openKnowledgeModule}
          onManageEnvironment={openEnvironment}
          onCollapse={() => setChatPanelCollapsed(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {chatCollapsed ? (
          <aside className="chat-panel-collapsed" aria-label={t('chatCollapsed')}>
            <button
              type="button"
              className="chat-panel-toggle"
              title={chatPendingCount > 0 ? t('expandChatPending', { count: chatPendingCount }) : t('expandChat')}
              aria-label={chatPendingCount > 0 ? t('expandChatPending', { count: chatPendingCount }) : t('expandChat')}
              aria-expanded="false"
              onClick={() => setChatPanelCollapsed(false)}
            >
              <span aria-hidden>&lt;</span>
              {chatPendingCount > 0 ? (
                <span className="chat-pending-count" aria-hidden>{chatPendingCount > 9 ? '9+' : chatPendingCount}</span>
              ) : null}
            </button>
          </aside>
        ) : null}
      </div>

      <KnowledgeWorkspace hidden={activeWorkspace !== 'knowledge'} target={knowledgeTarget} />

      {sessionMenu ? (
        <SessionContextMenu
          target={sessionMenu}
          canCloseOthers={sessions.length > 1}
          onClose={() => setSessionMenu(null)}
          onRename={(sessionId) => {
            const session = sessions.find((candidate) => candidate.id === sessionId)
            if (session) setRenameSessionTarget({ id: session.id, title: session.title })
          }}
          onDuplicate={(sessionId) => { void handleDuplicateSession(sessionId) }}
          onCloseOthers={(sessionId) => {
            const snapshot = createCloseOtherSessionsSnapshot(sessions, sessionId)
            if (snapshot && snapshot.closeSessionIds.length > 0) setCloseOthersSnapshot(snapshot)
          }}
        />
      ) : null}

      <HostEditorModal
        open={hostEditorOpen}
        mode={hostEditorMode}
        host={editingHost}
        folderId={createHostFolderId}
        environments={environments}
        busy={formBusy}
        testing={Boolean(editingHost && testingHostId === editingHost.id)}
        onClose={() => {
          if (formBusy) return
          setHostEditorOpen(false)
          setEditingHost(null)
          setCreateHostFolderId(undefined)
        }}
        onSubmit={hostEditorMode === 'edit' ? handleUpdateHost : handleAddHost}
        onTest={hostEditorMode === 'edit' ? handleTestHostDraft : undefined}
      />

      <ConfirmDeleteHostModal
        host={pendingDeleteHost}
        busy={Boolean(pendingDeleteHost && deletingHostId === pendingDeleteHost.id)}
        onCancel={() => {
          if (!deletingHostId) setPendingDeleteHost(null)
        }}
        onConfirm={(host) => {
          void handleRemoveHost(host)
        }}
      />

      <ConfirmCloseSessionModal
        session={pendingCloseSession}
        onCancel={() => setPendingCloseSession(null)}
        onConfirm={(session) => {
          setPendingCloseSession(null)
          void handleCloseSession(session.id)
        }}
      />

      <RenameSessionModal
        session={renameSessionTarget}
        onCancel={() => setRenameSessionTarget(null)}
        onSubmit={handleRenameSession}
      />

      <ConfirmCloseOtherSessionsModal
        snapshot={closeOthersSnapshot}
        busy={closingOtherSessions}
        onCancel={() => {
          if (!closingOtherSessions) setCloseOthersSnapshot(null)
        }}
        onConfirm={(snapshot) => { void handleCloseOtherSessions(snapshot) }}
      />

      <ConnectionModal
        open={connectionOpen}
        host={connectionHost}
        busy={Boolean(connectionHost && busyHostIds.has(connectionHost.id))}
        onClose={() => {
          setConnectionOpen(false)
          setConnectionHost(null)
        }}
        onConnect={handleModalConnect}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => setSettings(s)}
      />
      <HostVerifyDialog request={hostVerify} onRespond={handleHostVerifyRespond} />
    </div>
  )
}
