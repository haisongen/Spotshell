import type { AppMenuId, AppMenuPopupRequest } from '../shared/ipc-types'

export const APP_MENU_IDS: readonly AppMenuId[] = ['file', 'edit', 'view', 'window', 'help']

export type TitleBarMenuKeyAction =
  | { type: 'focus'; menuId: AppMenuId }
  | { type: 'open' }

export function moveMenuFocus(
  currentId: AppMenuId,
  direction: 'next' | 'previous' | 'first' | 'last'
): AppMenuId {
  if (direction === 'first') return APP_MENU_IDS[0]
  if (direction === 'last') return APP_MENU_IDS[APP_MENU_IDS.length - 1]

  const currentIndex = APP_MENU_IDS.indexOf(currentId)
  const offset = direction === 'next' ? 1 : -1
  return APP_MENU_IDS[(currentIndex + offset + APP_MENU_IDS.length) % APP_MENU_IDS.length]
}

export function getMenuKeyAction(
  currentId: AppMenuId,
  key: string
): TitleBarMenuKeyAction | null {
  if (key === 'ArrowLeft') return { type: 'focus', menuId: moveMenuFocus(currentId, 'previous') }
  if (key === 'ArrowRight') return { type: 'focus', menuId: moveMenuFocus(currentId, 'next') }
  if (key === 'Home') return { type: 'focus', menuId: moveMenuFocus(currentId, 'first') }
  if (key === 'End') return { type: 'focus', menuId: moveMenuFocus(currentId, 'last') }
  if (key === 'ArrowDown' || key === 'Enter' || key === ' ') return { type: 'open' }
  return null
}

export function getMenuPopupRequest(
  menuId: AppMenuId,
  rect: Pick<DOMRect, 'left' | 'bottom'>
): AppMenuPopupRequest {
  return {
    menuId,
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.bottom)),
  }
}
