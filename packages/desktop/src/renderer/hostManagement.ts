import type {
  HostConnectionTestDraft,
  SavedHostInput,
  SavedHostProfile,
} from '../shared/ipc-types'

export interface HostEditorFormValues {
  name: string
  host: string
  port: string
  username: string
  authMethod: 'key' | 'password' | 'agent'
  privateKeyPath: string
  password: string
  notes: string
  environmentId?: string
}

export type HostFormValidationError =
  | 'requiredHostFields'
  | 'invalidPort'
  | 'confirmPasswordClear'

export type HostFormConversionResult =
  | { ok: true; input: SavedHostInput }
  | { ok: false; error: HostFormValidationError }

export type HostTestDraftConversionResult =
  | { ok: true; draft: HostConnectionTestDraft }
  | { ok: false; error: Exclude<HostFormValidationError, 'confirmPasswordClear'> | 'privateKeyRequired' | 'passwordAuthRequired' }

export interface HostFormConversionOptions {
  hasSavedPassword?: boolean
  initialAuthMethod?: 'key' | 'password' | 'agent'
  clearSavedPassword?: boolean
}

export function formatHostTarget(
  host: Pick<SavedHostProfile, 'username' | 'host' | 'port'>
): string {
  return `${host.username}@${host.host}:${host.port}`
}

export function filterHosts(hosts: SavedHostProfile[], query: string): SavedHostProfile[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return hosts

  return hosts.filter((host) =>
    [host.name, host.host, host.username, formatHostTarget(host)].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    )
  )
}

export function hostToEditorForm(host?: SavedHostProfile | null): HostEditorFormValues {
  return {
    name: host?.name ?? '',
    host: host?.host ?? '',
    port: String(host?.port ?? 22),
    username: host?.username ?? '',
    authMethod: host?.authMethod ?? (host?.hasPassword ? 'password' : 'key'),
    privateKeyPath: host?.privateKeyPath ?? '',
    password: '',
    notes: host?.notes ?? '',
    environmentId: host?.environmentId,
  }
}

export function convertHostForm(
  form: HostEditorFormValues,
  options: HostFormConversionOptions = {}
): HostFormConversionResult {
  const name = form.name.trim()
  const host = form.host.trim()
  const username = form.username.trim()
  const portText = form.port.trim()
  const port = Number(portText)

  if (!name || !host || !username) return { ok: false, error: 'requiredHostFields' }
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'invalidPort' }
  }

  const changedAwayFromPassword =
    options.hasSavedPassword &&
    options.initialAuthMethod === 'password' &&
    form.authMethod !== 'password'
  if (changedAwayFromPassword && !options.clearSavedPassword) {
    return { ok: false, error: 'confirmPasswordClear' }
  }

  const password = form.password
    ? form.password
    : options.clearSavedPassword
      ? ''
      : undefined

  return {
    ok: true,
    input: {
      name,
      host,
      port,
      username,
      authMethod: form.authMethod,
      privateKeyPath: form.authMethod === 'key' ? form.privateKeyPath.trim() || undefined : undefined,
      password,
      notes: form.notes.trim() || undefined,
      environmentId: form.environmentId,
    },
  }
}

export function convertHostTestDraft(
  form: HostEditorFormValues,
  options: Pick<HostFormConversionOptions, 'hasSavedPassword' | 'clearSavedPassword'> = {}
): HostTestDraftConversionResult {
  const host = form.host.trim()
  const username = form.username.trim()
  const portText = form.port.trim()
  const port = Number(portText)
  if (!host || !username) return { ok: false, error: 'requiredHostFields' }
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'invalidPort' }
  }

  const privateKeyPath = form.privateKeyPath.trim()
  if (form.authMethod === 'key' && !privateKeyPath) {
    return { ok: false, error: 'privateKeyRequired' }
  }
  const password = form.password || undefined
  const useSavedPassword =
    form.authMethod === 'password' &&
    !password &&
    Boolean(options.hasSavedPassword) &&
    !options.clearSavedPassword
  if (form.authMethod === 'password' && !password && !useSavedPassword) {
    return { ok: false, error: 'passwordAuthRequired' }
  }
  return {
    ok: true,
    draft: {
      host,
      port,
      username,
      authMethod: form.authMethod,
      privateKeyPath: form.authMethod === 'key' ? privateKeyPath : undefined,
      password: form.authMethod === 'password' ? password : undefined,
      useSavedPassword,
    },
  }
}
