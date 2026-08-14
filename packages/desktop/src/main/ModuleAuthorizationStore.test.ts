import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ModuleAuthorizationStore } from './ModuleAuthorizationStore'

test('global on-demand authorization persists locally and can be revoked', (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-module-authorization-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const filePath = path.join(rootPath, 'module-authorizations.json')
  const moduleId = '123e4567-e89b-42d3-a456-426614174000'
  const store = new ModuleAuthorizationStore(filePath)

  store.setGlobalOnDemand(moduleId, true)

  assert.deepEqual(new ModuleAuthorizationStore(filePath).listGlobalOnDemandIds(), [moduleId])
  store.setGlobalOnDemand(moduleId, false)
  assert.deepEqual(new ModuleAuthorizationStore(filePath).listGlobalOnDemandIds(), [])
})

test('malformed authorization data fails closed and is replaced by the next valid update', (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-module-authorization-invalid-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const filePath = path.join(rootPath, 'module-authorizations.json')
  const moduleId = '123e4567-e89b-42d3-a456-426614174000'
  fs.writeFileSync(filePath, '{"globalOnDemand":["not-a-module-id"]}', 'utf8')
  const store = new ModuleAuthorizationStore(filePath)

  assert.deepEqual(store.listGlobalOnDemandIds(), [])
  store.setGlobalOnDemand(moduleId, true)
  assert.deepEqual(new ModuleAuthorizationStore(filePath).listGlobalOnDemandIds(), [moduleId])
})

test('failed atomic writes clean up their temporary file', (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-module-authorization-write-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const directoryTarget = path.join(rootPath, 'module-authorizations.json')
  fs.mkdirSync(directoryTarget)
  const store = new ModuleAuthorizationStore(directoryTarget)

  assert.throws(
    () => store.setGlobalOnDemand('123e4567-e89b-42d3-a456-426614174000', true)
  )
  assert.deepEqual(
    fs.readdirSync(rootPath).filter((name) => name.endsWith('.tmp')),
    []
  )
})
