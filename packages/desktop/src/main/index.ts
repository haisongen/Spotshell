import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerIpc } from './ipc'
import { SessionManager } from './SessionManager'
import { settingsStore } from './settingsStore'
import { hideApplicationMenuBar, installApplicationMenu } from './appMenu'
import { KnownHostsStore } from './KnownHostsStore'
import {
  auditLogFilePath,
  knownHostsFilePath,
  moduleAuthorizationsFilePath,
} from './paths'
import { AuditLog } from './AuditLog'
import { appendHostNote, hostStore, setHostNotes } from './hostsStore'
import { applyNativeTheme, NATIVE_TITLE_BAR_OVERLAY, NATIVE_WINDOW_BACKGROUND } from './theme'
import { WindowCloseController } from './WindowCloseController'
import { KnowledgeRepository } from '@spotshell/core'
import { knowledgeRootPath } from './paths'
import { HostEnvironmentBindings } from './HostEnvironmentBindings'
import { ModuleAuthorizationStore } from './ModuleAuthorizationStore'
import { KnowledgeCatalogService } from './KnowledgeCatalogService'
import { ExternalEditWatcher } from './ExternalEditWatcher'
import { runOfficialSeedMigration } from './seedModules'
import { IpcChannels } from '../shared/ipc-types'

// Keep taskbar grouping/icon association aligned with electron-builder appId.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.spotshell.app')
}

let mainWindow: BrowserWindow | null = null

/** Resolve packaged/dev app icon for BrowserWindow (Windows taskbar + window). */
function resolveAppIconPath(): string | undefined {
  const candidates = [
    // electron-vite out/main → packages/desktop/resources
    join(__dirname, '../../resources/icon.ico'),
    join(__dirname, '../../resources/icon.png'),
    // packaged extraResources fallback
    join(process.resourcesPath, 'icon.ico'),
    join(process.resourcesPath, 'icon.png'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}
const knowledgeRepository = new KnowledgeRepository(knowledgeRootPath())
const moduleAuthorizations = new ModuleAuthorizationStore(moduleAuthorizationsFilePath())
const hostEnvironmentBindings = new HostEnvironmentBindings(hostStore, knowledgeRepository)
const knowledgeCatalog = new KnowledgeCatalogService(knowledgeRepository, moduleAuthorizations)
const externalEditWatcher = new ExternalEditWatcher(knowledgeRepository, knowledgeRootPath())
const sessionManager = new SessionManager(
  () => settingsStore.getAgentConfig(),
  new KnownHostsStore(knownHostsFilePath()),
  new AuditLog(auditLogFilePath()),
  (hostId) => hostStore.get(hostId)?.notes,
  () => settingsStore.isShellIntegrationEnabled(),
  (hostId, note) => appendHostNote(hostId, note),
  undefined,
  undefined,
  hostEnvironmentBindings,
  knowledgeCatalog,
  (hostId, notes) => setHostNotes(hostId, notes),
)
const windowCloseController = new WindowCloseController({
  activeConnectionCount: () => sessionManager.activeConnectionCount(),
  confirmClose: async (activeCount) => {
    const language = settingsStore.getPublicSettings().language
    const zh = language === 'zh-CN'
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: zh ? '关闭 SpotShell？' : 'Close SpotShell?',
      message: zh ? '关闭 SpotShell？' : 'Close SpotShell?',
      detail: zh
        ? `当前有 ${activeCount} 个会话仍在连接。退出将断开全部 SSH 连接。`
        : `${activeCount} sessions are still connected. Quitting will disconnect all SSH connections.`,
      buttons: zh ? ['取消', '断开全部连接并退出'] : ['Cancel', 'Disconnect All and Quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    return result.response === 1
  },
  closeAll: () => sessionManager.closeAll(),
  completeClose: () => app.quit(),
})

function createWindow(): void {
  const theme = settingsStore.getPublicSettings().theme
  const icon = resolveAppIconPath()
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: NATIVE_WINDOW_BACKGROUND[theme],
    titleBarStyle: 'hidden',
    titleBarOverlay: NATIVE_TITLE_BAR_OVERLAY[theme],
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: 'SpotShell',
  })
  hideApplicationMenuBar(mainWindow)
  mainWindow.on('close', (event) => {
    if (windowCloseController.requestClose()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  applyNativeTheme(settingsStore.getPublicSettings().theme)
  registerIpc(
    () => mainWindow,
    sessionManager,
    knowledgeRepository,
    hostEnvironmentBindings,
    moduleAuthorizations,
  )
  createWindow()
  installApplicationMenu(() => mainWindow)

  externalEditWatcher.onChange((statuses) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IpcChannels.knowledgeExternalChangesEvent, statuses)
  })
  externalEditWatcher.start()
  void externalEditWatcher.scanAllNow().catch((error: unknown) => {
    console.error(
      '[SpotShell] external-edit startup scan failed:',
      error instanceof Error ? error.message : error,
    )
  })
  void runOfficialSeedMigration(
    knowledgeRepository,
    knowledgeRootPath(),
    moduleAuthorizations,
  ).catch((error: unknown) => {
    console.error(
      '[SpotShell] official seed migration failed:',
      error instanceof Error ? error.message : error,
    )
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  externalEditWatcher.stop()
  if (windowCloseController.requestClose()) event.preventDefault()
})
