import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { HostCredentialStore, type CredentialCipher } from './HostCredentialStore'

const testCipher: CredentialCipher = {
  encrypt(value) {
    return Buffer.from(`encrypted:${value}`, 'utf8')
  },
  decrypt(value) {
    return value.toString('utf8').replace(/^encrypted:/, '')
  },
}

test('stores encrypted host passwords and retrieves them by host id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-credentials-'))
  const file = path.join(dir, 'host-credentials.json')
  const store = new HostCredentialStore(file, testCipher)

  store.set('host-1', 'correct horse battery staple')

  assert.equal(store.has('host-1'), true)
  assert.equal(store.get('host-1'), 'correct horse battery staple')
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /correct horse battery staple/)
})

test('removes a saved password and treats an empty password as removal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-credentials-'))
  const store = new HostCredentialStore(path.join(dir, 'host-credentials.json'), testCipher)

  store.set('host-1', 'secret')
  store.set('host-1', '')
  assert.equal(store.has('host-1'), false)
  assert.equal(store.get('host-1'), undefined)

  store.set('host-2', 'secret')
  store.remove('host-2')
  assert.equal(store.has('host-2'), false)
})
