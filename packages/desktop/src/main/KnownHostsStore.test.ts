import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { KnownHostsStore } from './KnownHostsStore'

test('stores and retrieves fingerprints per host:port', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-knownhosts-'))
  const store = new KnownHostsStore(path.join(dir, 'known_hosts.json'))

  assert.equal(store.get('example.com', 22), undefined)

  store.set('example.com', 22, 'SHA256:abc')
  assert.equal(store.get('example.com', 22), 'SHA256:abc')
  assert.equal(store.get('example.com', 2222), undefined)

  store.remove('example.com', 22)
  assert.equal(store.get('example.com', 22), undefined)
})

test('survives a corrupt file by starting empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-knownhosts-'))
  const file = path.join(dir, 'known_hosts.json')
  fs.writeFileSync(file, 'not json', 'utf8')
  const store = new KnownHostsStore(file)
  assert.equal(store.get('example.com', 22), undefined)
  store.set('example.com', 22, 'SHA256:abc')
  assert.equal(store.get('example.com', 22), 'SHA256:abc')
})
