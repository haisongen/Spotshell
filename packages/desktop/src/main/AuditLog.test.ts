import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AuditLog } from './AuditLog'

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-audit-')), 'audit.jsonl')
}

test('appends one JSON line per record', () => {
  const file = tmpFile()
  const log = new AuditLog(file)
  log.append({ sessionId: 's1', host: 'h', tool: 'execute_ssh_command', command: 'ls', risk: 'readonly', decision: 'auto' })
  log.append({ sessionId: 's1', host: 'h', tool: 'execute_ssh_command', command: 'rm -rf /x', risk: 'destructive', decision: 'denied' })
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0]!)
  assert.equal(first.command, 'ls')
  assert.ok(first.ts)
})

test('rotates when file exceeds maxBytes', () => {
  const file = tmpFile()
  const log = new AuditLog(file, 200)
  for (let i = 0; i < 20; i += 1) {
    log.append({ sessionId: 's', host: 'h', tool: 'execute_ssh_command', command: 'x'.repeat(50), risk: 'write', decision: 'auto' })
  }
  assert.ok(fs.existsSync(`${file}.1`))
  assert.ok(fs.statSync(file).size < 400)
})

test('append never throws even if directory vanishes mid-run', () => {
  const file = tmpFile()
  const log = new AuditLog(file)
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
  assert.doesNotThrow(() =>
    log.append({ sessionId: 's', host: 'h', tool: 'execute_ssh_command', command: 'ls', risk: 'readonly', decision: 'auto' })
  )
})
