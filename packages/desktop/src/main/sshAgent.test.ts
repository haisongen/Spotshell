import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSshAgentSocket } from './sshAgent'

test('uses SSH_AUTH_SOCK when configured', () => {
  assert.equal(resolveSshAgentSocket({ SSH_AUTH_SOCK: ' /tmp/agent.sock ' }, 'linux'), '/tmp/agent.sock')
})

test('uses the OpenSSH named pipe on Windows', () => {
  assert.equal(resolveSshAgentSocket({}, 'win32'), '\\\\.\\pipe\\openssh-ssh-agent')
})

test('reports no agent on Unix when SSH_AUTH_SOCK is absent', () => {
  assert.equal(resolveSshAgentSocket({}, 'linux'), undefined)
})
