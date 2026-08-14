import { dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IpcChannels, type AppLanguage, type AppMenuId } from '../shared/ipc-types'
import { settingsStore } from './settingsStore'

const labels = {
  en: {
    file: 'File',
    exit: 'Exit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    reload: 'Reload',
    forceReload: 'Force Reload',
    developerTools: 'Developer Tools',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullScreen: 'Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    closeWindow: 'Close Window',
    language: 'Language',
    english: 'English',
    simplifiedChinese: 'Simplified Chinese',
    help: 'Help',
    about: 'About SpotShell',
    aboutDetail: 'SSH desktop workspace',
  },
  'zh-CN': {
    file: '文件',
    exit: '退出',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    view: '视图',
    reload: '重新加载',
    forceReload: '强制重新加载',
    developerTools: '开发者工具',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullScreen: '全屏',
    window: '窗口',
    minimize: '最小化',
    closeWindow: '关闭窗口',
    language: '语言',
    english: '英文',
    simplifiedChinese: '简体中文',
    help: '帮助',
    about: '关于 SpotShell',
    aboutDetail: 'SSH 桌面工作区',
  },
} as const

export function hideApplicationMenuBar(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  window.setAutoHideMenuBar(false)
  window.setMenuBarVisibility(false)
}

export function installApplicationMenu(getWindow: () => BrowserWindow | null): void {
  const language = settingsStore.getPublicSettings().language
  const t = labels[language]

  const changeLanguage = (nextLanguage: AppLanguage): void => {
    if (nextLanguage === language) return
    settingsStore.update({ language: nextLanguage })
    getWindow()?.webContents.send(IpcChannels.languageChanged, nextLanguage)
    installApplicationMenu(getWindow)
  }

  const template: MenuItemConstructorOptions[] = [
    {
      id: 'file',
      label: t.file,
      submenu: [{ label: t.exit, role: 'quit' }],
    },
    {
      id: 'edit',
      label: t.edit,
      submenu: [
        { label: t.undo, role: 'undo' },
        { label: t.redo, role: 'redo' },
        { type: 'separator' },
        { label: t.cut, role: 'cut' },
        { label: t.copy, role: 'copy' },
        { label: t.paste, role: 'paste' },
        { label: t.selectAll, role: 'selectAll' },
      ],
    },
    {
      id: 'view',
      label: t.view,
      submenu: [
        { label: t.reload, role: 'reload' },
        { label: t.forceReload, role: 'forceReload' },
        { label: t.developerTools, role: 'toggleDevTools' },
        { type: 'separator' },
        { label: t.actualSize, role: 'resetZoom' },
        { label: t.zoomIn, role: 'zoomIn' },
        { label: t.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: t.fullScreen, role: 'togglefullscreen' },
      ],
    },
    {
      id: 'window',
      label: t.window,
      submenu: [
        { label: t.minimize, role: 'minimize' },
        { label: t.closeWindow, click: () => getWindow()?.close() },
        { type: 'separator' },
        {
          label: t.language,
          submenu: [
            {
              label: t.english,
              type: 'radio',
              checked: language === 'en',
              click: () => changeLanguage('en'),
            },
            {
              label: t.simplifiedChinese,
              type: 'radio',
              checked: language === 'zh-CN',
              click: () => changeLanguage('zh-CN'),
            },
          ],
        },
      ],
    },
    {
      id: 'help',
      label: t.help,
      submenu: [
        {
          label: t.about,
          click: () => {
            const options = {
              type: 'info',
              title: t.about,
              message: 'SpotShell',
              detail: t.aboutDetail,
            } as const
            const window = getWindow()
            void (window
              ? dialog.showMessageBox(window, options)
              : dialog.showMessageBox(options))
          },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  hideApplicationMenuBar(getWindow())
}

export function popupApplicationMenu(
  window: BrowserWindow,
  menuId: AppMenuId,
  x: number,
  y: number
): Promise<void> {
  if (window.isDestroyed()) return Promise.reject(new Error('Application window is unavailable'))

  const applicationMenu = Menu.getApplicationMenu()
  if (!applicationMenu) return Promise.reject(new Error('Application menu is unavailable'))

  const menuItem = applicationMenu.getMenuItemById(menuId)
  if (!menuItem?.submenu) return Promise.reject(new Error(`Application menu not found: ${menuId}`))

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }

    try {
      menuItem.submenu.popup({ window, x, y, callback: () => finish() })
    } catch (error) {
      finish(error)
    }
  })
}
