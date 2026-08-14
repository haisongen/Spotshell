import assert from 'node:assert/strict'
import test from 'node:test'
import { APP_MENU_IDS, getMenuKeyAction, getMenuPopupRequest, moveMenuFocus } from './titleBarMenu'

test('APP_MENU_IDS keeps the approved visual and focus order', () => {
  assert.deepEqual(APP_MENU_IDS, ['file', 'edit', 'view', 'window', 'help'])
})

test('moveMenuFocus wraps in both directions and supports Home and End', () => {
  assert.equal(moveMenuFocus('file', 'previous'), 'help')
  assert.equal(moveMenuFocus('help', 'next'), 'file')
  assert.equal(moveMenuFocus('view', 'first'), 'file')
  assert.equal(moveMenuFocus('view', 'last'), 'help')
})

test('getMenuKeyAction maps navigation and open keys only', () => {
  assert.deepEqual(getMenuKeyAction('edit', 'ArrowRight'), { type: 'focus', menuId: 'view' })
  assert.deepEqual(getMenuKeyAction('edit', 'ArrowLeft'), { type: 'focus', menuId: 'file' })
  assert.deepEqual(getMenuKeyAction('edit', 'Home'), { type: 'focus', menuId: 'file' })
  assert.deepEqual(getMenuKeyAction('edit', 'End'), { type: 'focus', menuId: 'help' })
  for (const key of ['ArrowDown', 'Enter', ' ']) {
    assert.deepEqual(getMenuKeyAction('edit', key), { type: 'open' })
  }
  assert.equal(getMenuKeyAction('edit', 'Escape'), null)
  assert.equal(getMenuKeyAction('edit', 'a'), null)
})

test('getMenuPopupRequest rounds coordinates and never returns negatives', () => {
  assert.deepEqual(getMenuPopupRequest('file', { left: 18.4, bottom: 39.6 }), {
    menuId: 'file', x: 18, y: 40,
  })
  assert.deepEqual(getMenuPopupRequest('help', { left: -10.2, bottom: -0.6 }), {
    menuId: 'help', x: 0, y: 0,
  })
})
