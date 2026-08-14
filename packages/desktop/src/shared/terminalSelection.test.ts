import assert from 'node:assert/strict'
import test from 'node:test'
import { getAskAiSelection } from './terminalSelection'

test('Ask AI requires an xterm selection with non-whitespace content', () => {
  assert.equal(getAskAiSelection(false, 'error'), null)
  assert.equal(getAskAiSelection(true, '   \n'), null)
  assert.equal(getAskAiSelection(true, ' error \n'), ' error \n')
})
