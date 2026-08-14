import assert from 'node:assert/strict'
import test from 'node:test'
import { appendTerminalPrefill, terminalInputForCommand } from './chatDraft'

test('terminal command insertion strips one trailing newline and run adds one newline', () => {
  assert.equal(terminalInputForCommand('df -h\n', false), 'df -h')
  assert.equal(terminalInputForCommand('df -h\r\n', false), 'df -h')
  assert.equal(terminalInputForCommand('cd /var/log\ntail app.log\n', true), 'cd /var/log\ntail app.log\n')
})

test('terminal selection is normalized into a fenced draft and appended to existing text', () => {
  assert.equal(appendTerminalPrefill('', 'error\r\nline 2\r\n'), '```\nerror\nline 2\n```\n')
  assert.equal(
    appendTerminalPrefill('这是什么错误？', 'permission denied'),
    '这是什么错误？\n```\npermission denied\n```\n'
  )
})
