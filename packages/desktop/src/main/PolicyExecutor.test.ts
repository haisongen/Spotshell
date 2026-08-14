import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommandResult, ExecPolicy, SSHExecutor } from '@spotshell/core'
import type { AuditRecord } from './AuditLog'
import { PolicyExecutor, type ToolEndMeta } from './PolicyExecutor'

function okResult(command: string): CommandResult {
  return { command, stdout: 'ok', stderr: '', exitCode: 0, durationMs: 12, timedOut: false }
}

function fakeInner(): { calls: string[]; writes: string[]; executor: SSHExecutor } {
  const calls: string[] = []
  const writes: string[] = []
  return {
    calls,
    writes,
    executor: {
      execute: async (command) => {
        calls.push(command)
        return okResult(command)
      },
      write: async (data) => {
        writes.push(data)
        return true
      },
    },
  }
}

function harness(initialPolicy: ExecPolicy = 'ask', initialAnswer = true) {
  const inner = fakeInner()
  let policy = initialPolicy
  let answer = initialAnswer
  const confirms: string[] = []
  const records: Array<Omit<AuditRecord, 'sessionId' | 'host'>> = []
  const ends: Array<{ output?: string; meta?: ToolEndMeta }> = []
  const executor = new PolicyExecutor(inner.executor, {
    getPolicy: () => policy,
    requestConfirm: async (command) => {
      confirms.push(command)
      return answer
    },
    onTool: (phase, _name, _command, output, meta) => {
      if (phase === 'end') ends.push({ output, meta })
    },
    audit: (record) => records.push(record),
  })
  return {
    inner,
    executor,
    confirms,
    records,
    ends,
    setPolicy(value: ExecPolicy) { policy = value },
    setAnswer(value: boolean) { answer = value },
  }
}

test('ask allows readonly commands automatically', async () => {
  const h = harness()
  await h.executor.execute('ls')
  assert.deepEqual(h.confirms, [])
  assert.deepEqual(h.inner.calls, ['ls'])
  assert.equal(h.records[0]?.decision, 'auto')
})

test('ask confirms write commands and records confirmed execution', async () => {
  const h = harness()
  await h.executor.execute('mkdir /x')
  assert.deepEqual(h.confirms, ['mkdir /x'])
  assert.deepEqual(h.inner.calls, ['mkdir /x'])
  assert.equal(h.records[0]?.decision, 'confirmed')
})

test('ask denial returns a synthetic result without executing', async () => {
  const h = harness('ask', false)
  const result = await h.executor.execute('mkdir /x')
  assert.equal(result.exitCode, null)
  assert.match(result.stderr, /取消/)
  assert.deepEqual(h.inner.calls, [])
  assert.equal(h.records[0]?.decision, 'denied')
})

test('ask confirms destructive commands', async () => {
  const h = harness()
  await h.executor.execute('rm -rf /x')
  assert.deepEqual(h.confirms, ['rm -rf /x'])
})

test('auto allows write but still confirms destructive commands', async () => {
  const h = harness('auto')
  await h.executor.execute('mkdir /x')
  await h.executor.execute('rm -rf /x')
  assert.deepEqual(h.confirms, ['rm -rf /x'])
  assert.equal(h.records[0]?.decision, 'auto')
  assert.equal(h.records[1]?.decision, 'confirmed')
})

test('readonly rejects write without confirmation and allows readonly', async () => {
  const h = harness('readonly')
  const denied = await h.executor.execute('touch /x')
  await h.executor.execute('df -h')
  assert.match(denied.stderr, /只读/)
  assert.deepEqual(h.confirms, [])
  assert.deepEqual(h.inner.calls, ['df -h'])
  assert.equal(h.records[0]?.decision, 'denied')
})

test('write path applies confirmation and readonly policy', async () => {
  const h = harness('ask', false)
  assert.equal(await h.executor.write('rm -rf /x\n'), false)
  assert.deepEqual(h.inner.writes, [])
  h.setPolicy('readonly')
  h.setAnswer(true)
  assert.equal(await h.executor.write('mkdir /x\n'), false)
  assert.deepEqual(h.inner.writes, [])
  assert.equal(h.confirms.length, 1)
})

test('execute tool_end includes risk, decision and command result metadata', async () => {
  const h = harness()
  await h.executor.execute('ls')
  assert.deepEqual(h.ends[0]?.meta, {
    risk: 'readonly',
    decision: 'auto',
    exitCode: 0,
    durationMs: 12,
    timedOut: false,
  })
  assert.match(h.ends[0]?.output ?? '', /\[exit_code=0\]/)
})

test('auto-allowed execute raises agent-command-running around inner.execute', async () => {
  const transitions: boolean[] = []
  const inner = fakeInner()
  const executor = new PolicyExecutor(inner.executor, {
    getPolicy: () => 'ask',
    requestConfirm: async () => true,
    onAgentCommandRunning: (running) => transitions.push(running),
  })
  await executor.execute('ls')
  assert.deepEqual(transitions, [true, false])
})

test('confirmed execute does not double-raise running (approve path already gated)', async () => {
  const transitions: boolean[] = []
  const inner = fakeInner()
  const executor = new PolicyExecutor(inner.executor, {
    getPolicy: () => 'ask',
    requestConfirm: async () => true,
    onAgentCommandRunning: (running) => transitions.push(running),
  })
  await executor.execute('touch /tmp/x')
  // decision=confirmed: only the finally decrement is emitted from PolicyExecutor.
  assert.deepEqual(transitions, [false])
  assert.deepEqual(inner.calls, ['touch /tmp/x'])
})

test('opaque input is destructive and requires confirmation', async () => {
  const h = harness('auto', false)
  await h.executor.execute('echo $(x)')
  assert.deepEqual(h.confirms, ['echo $(x)'])
  assert.equal(h.records[0]?.risk, 'destructive')
})
