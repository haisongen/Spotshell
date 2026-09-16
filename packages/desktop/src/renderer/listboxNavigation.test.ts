import assert from 'node:assert/strict'
import test from 'node:test'
import { activeOptionIndex, nextListboxIndex } from './listboxNavigation'

test('moves focus down and up with wrapping', () => {
  assert.equal(nextListboxIndex('ArrowDown', 0, 3), 1)
  assert.equal(nextListboxIndex('ArrowDown', 2, 3), 0)
  assert.equal(nextListboxIndex('ArrowUp', 1, 3), 0)
  assert.equal(nextListboxIndex('ArrowUp', 0, 3), 2)
})

test('enters the list from either end when nothing is focused yet', () => {
  assert.equal(nextListboxIndex('ArrowDown', -1, 3), 0)
  assert.equal(nextListboxIndex('ArrowUp', -1, 3), 2)
})

test('jumps to the ends with Home and End', () => {
  assert.equal(nextListboxIndex('Home', 2, 3), 0)
  assert.equal(nextListboxIndex('End', 0, 3), 2)
})

test('ignores non-navigation keys and empty lists', () => {
  assert.equal(nextListboxIndex('Enter', 0, 3), null)
  assert.equal(nextListboxIndex('a', 0, 3), null)
  assert.equal(nextListboxIndex('ArrowDown', 0, 0), null)
})

test('puts the roving tabstop on the selected row', () => {
  assert.equal(activeOptionIndex(['a', 'b', 'c'], 'b'), 1)
})

test('falls back to the first row when the selection is missing or filtered out', () => {
  assert.equal(activeOptionIndex(['a', 'b'], null), 0)
  assert.equal(activeOptionIndex(['a', 'b'], 'gone'), 0)
})

test('reports no tabstop for an empty list', () => {
  assert.equal(activeOptionIndex([], 'a'), -1)
})
