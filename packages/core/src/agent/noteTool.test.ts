import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSSHTools } from './tools.js'
import type { SSHExecutor } from './types.js'

const executor: SSHExecutor = {
  execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, timedOut: false }),
  write: async () => true,
}

describe('propose_host_note tool', () => {
  it('is absent without the capability (CLI unchanged)', () => {
    const names = createSSHTools(executor).map((t) => t.name)
    assert.ok(!names.includes('propose_host_note'))
  })

  it('is registered with the capability and returns the callback message', async () => {
    const received: string[] = []
    const tools = createSSHTools(executor, {
      proposeHostNote: async (note) => {
        received.push(note)
        return '已保存到主机档案'
      },
    })
    const tool = tools.find((t) => t.name === 'propose_host_note')
    assert.ok(tool)
    const result = await tool!.invoke({ note: 'GSS 报错无害' })
    assert.equal(result, '已保存到主机档案')
    assert.deepEqual(received, ['GSS 报错无害'])
  })

  it('reports callback failures instead of throwing', async () => {
    const tools = createSSHTools(executor, {
      proposeHostNote: async () => { throw new Error('boom') },
    })
    const tool = tools.find((t) => t.name === 'propose_host_note')!
    const result = await tool.invoke({ note: 'n' })
    assert.match(String(result), /boom/)
  })
})
