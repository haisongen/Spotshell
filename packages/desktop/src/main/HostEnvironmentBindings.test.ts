import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { HostStore, KnowledgeRepository } from '@spotshell/core'
import { HostEnvironmentBindings } from './HostEnvironmentBindings'

test('host environment bindings validate targets and expose reverse references', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-host-environments-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const hostStore = new HostStore(path.join(root, 'hosts.json'))
  const repository = new KnowledgeRepository(path.join(root, 'knowledge'))
  const bindings = new HostEnvironmentBindings(hostStore, repository)
  const environment = await repository.createEnvironmentDraft({ name: 'Production' })
  const host = hostStore.add({ name: 'prod', host: 'h', port: 22, username: 'ops' })

  await bindings.assertEnvironmentExists(environment.id)
  bindings.setBoundEnvironmentId(host.id, environment.id)

  assert.equal(bindings.getBoundEnvironmentId(host.id), environment.id)
  assert.equal(await bindings.environmentExists(environment.id), true)
  assert.deepEqual(bindings.listHosts(environment.id).map((entry) => entry.id), [host.id])

  await assert.rejects(bindings.assertEnvironmentExists(crypto.randomUUID()), /not found/i)
  bindings.setBoundEnvironmentId(host.id, undefined)
  assert.deepEqual(bindings.listHosts(environment.id), [])
})
