import assert from 'node:assert/strict'
import test from 'node:test'
import type { SavedHostProfile } from '../shared/ipc-types'
import {
  convertHostForm,
  convertHostTestDraft,
  filterHosts,
  formatHostTarget,
  hostToEditorForm,
  type HostEditorFormValues,
} from './hostManagement'

const hosts: SavedHostProfile[] = [
  {
    id: 'one',
    name: 'Prod Jump',
    host: '10.20.30.40',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    hasPassword: true,
  },
  {
    id: 'two',
    name: 'Database',
    host: 'db.internal',
    port: 2222,
    username: 'postgres',
    authMethod: 'key',
    hasPassword: false,
  },
]

const validForm: HostEditorFormValues = {
  name: ' App server ',
  host: ' 192.168.1.5 ',
  port: '22',
  username: ' root ',
  authMethod: 'password',
  privateKeyPath: ' ',
  password: '',
  notes: ' production ',
  environmentId: 'env-prod',
}

test('formats a host target', () => {
  assert.equal(formatHostTarget(hosts[1]), 'postgres@db.internal:2222')
})

test('empty and whitespace queries preserve the original host list', () => {
  assert.equal(filterHosts(hosts, ''), hosts)
  assert.equal(filterHosts(hosts, '   '), hosts)
})

test('filters case-insensitively across alias, address, username, and target', () => {
  assert.deepEqual(filterHosts(hosts, 'pRoD').map((host) => host.id), ['one'])
  assert.deepEqual(filterHosts(hosts, '20.30').map((host) => host.id), ['one'])
  assert.deepEqual(filterHosts(hosts, 'POSTGR').map((host) => host.id), ['two'])
  assert.deepEqual(filterHosts(hosts, 'deploy@10.20').map((host) => host.id), ['one'])
  assert.deepEqual(filterHosts(hosts, 'missing'), [])
})

test('converts and trims valid form values', () => {
  assert.deepEqual(convertHostForm(validForm), {
    ok: true,
    input: {
      name: 'App server',
      host: '192.168.1.5',
      port: 22,
      username: 'root',
      authMethod: 'password',
      privateKeyPath: undefined,
      password: undefined,
      notes: 'production',
      environmentId: 'env-prod',
    },
  })
})

test('validates required fields and a strict integer port range', () => {
  assert.deepEqual(convertHostForm({ ...validForm, name: ' ' }), {
    ok: false,
    error: 'requiredHostFields',
  })
  for (const port of ['', '0', '65536', '22.5', '22abc']) {
    assert.deepEqual(convertHostForm({ ...validForm, port }), {
      ok: false,
      error: 'invalidPort',
    })
  }
})

test('omits an untouched stored password, replaces it, or explicitly clears it', () => {
  const preserve = convertHostForm(validForm, { hasSavedPassword: true })
  assert.equal(preserve.ok && preserve.input.password, undefined)

  const replace = convertHostForm(
    { ...validForm, password: 'replacement' },
    { hasSavedPassword: true, clearSavedPassword: true }
  )
  assert.equal(replace.ok && replace.input.password, 'replacement')

  const clear = convertHostForm(validForm, {
    hasSavedPassword: true,
    clearSavedPassword: true,
  })
  assert.equal(clear.ok && clear.input.password, '')
})

test('requires explicit password clearing when changing away from password authentication', () => {
  const keyForm = { ...validForm, authMethod: 'key' as const }
  assert.deepEqual(
    convertHostForm(keyForm, { hasSavedPassword: true, initialAuthMethod: 'password' }),
    { ok: false, error: 'confirmPasswordClear' }
  )

  const confirmed = convertHostForm(keyForm, {
    hasSavedPassword: true,
    initialAuthMethod: 'password',
    clearSavedPassword: true,
  })
  assert.equal(confirmed.ok && confirmed.input.password, '')
  assert.equal(confirmed.ok && confirmed.input.privateKeyPath, undefined)
})

test('agent host saves omit stale private-key fields', () => {
  const result = convertHostForm({
    ...validForm, authMethod: 'agent', privateKeyPath: '/stale/key',
  })
  assert.equal(result.ok && result.input.privateKeyPath, undefined)
})

test('creates editor state without exposing a stored password', () => {
  assert.deepEqual(hostToEditorForm(hosts[0]), {
    name: 'Prod Jump',
    host: '10.20.30.40',
    port: '22',
    username: 'deploy',
    authMethod: 'password',
    privateKeyPath: '',
    password: '',
    notes: '',
    environmentId: undefined,
  })
})

test('editor state preserves and can clear an automatic environment binding', () => {
  const boundHost = { ...hosts[0], environmentId: 'env-prod' }
  assert.equal(hostToEditorForm(boundHost).environmentId, 'env-prod')
  const result = convertHostForm({ ...validForm, environmentId: undefined })
  assert.equal(result.ok && result.input.environmentId, undefined)
})

test('infers password auth for legacy saved hosts that only expose hasPassword', () => {
  const legacyHost: SavedHostProfile = {
    id: 'legacy',
    name: 'Legacy',
    host: 'legacy.internal',
    port: 22,
    username: 'root',
    hasPassword: true,
  }
  assert.equal(hostToEditorForm(legacyHost).authMethod, 'password')
})

test('converts a trimmed edit form into a connection-test draft', () => {
  assert.deepEqual(convertHostTestDraft({ ...validForm, password: 'temporary' }, {
    hasSavedPassword: true,
  }), {
    ok: true,
    draft: {
      host: '192.168.1.5', port: 22, username: 'root', authMethod: 'password',
      privateKeyPath: undefined, password: 'temporary', useSavedPassword: false,
    },
  })
})

test('test drafts validate connection fields independently of name and notes', () => {
  const withoutMetadata = { ...validForm, name: ' ', notes: 'ignored', password: 'temporary' }
  assert.equal(convertHostTestDraft(withoutMetadata).ok, true)
  assert.deepEqual(convertHostTestDraft({ ...withoutMetadata, host: ' ' }), {
    ok: false, error: 'requiredHostFields',
  })
  assert.deepEqual(convertHostTestDraft({ ...withoutMetadata, port: '22.5' }), {
    ok: false, error: 'invalidPort',
  })
  assert.deepEqual(convertHostTestDraft({
    ...withoutMetadata, authMethod: 'key', privateKeyPath: ' ',
  }), { ok: false, error: 'privateKeyRequired' })
})

test('test draft only falls back to a saved password when it remains preserved', () => {
  const fallback = convertHostTestDraft(validForm, { hasSavedPassword: true })
  assert.equal(fallback.ok && fallback.draft.useSavedPassword, true)
  const cleared = convertHostTestDraft(validForm, {
    hasSavedPassword: true, clearSavedPassword: true,
  })
  assert.deepEqual(cleared, { ok: false, error: 'passwordAuthRequired' })
  const agent = convertHostTestDraft({ ...validForm, authMethod: 'agent' }, {
    hasSavedPassword: true,
  })
  assert.equal(agent.ok && agent.draft.useSavedPassword, false)
})
