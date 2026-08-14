import { app } from 'electron'
import path from 'path'

export function getUserDataPath(...parts: string[]): string {
  return path.join(app.getPath('userData'), ...parts)
}

export function hostsFilePath(): string {
  return getUserDataPath('hosts.json')
}

export function hostCredentialsFilePath(): string {
  return getUserDataPath('host-credentials.json')
}

export function settingsFilePath(): string {
  return getUserDataPath('settings.json')
}

export function settingsSecretsPath(): string {
  return getUserDataPath('settings-secrets.bin')
}

export function knownHostsFilePath(): string {
  return getUserDataPath('known_hosts.json')
}

export function auditLogFilePath(): string {
  return getUserDataPath('audit.jsonl')
}

export function knowledgeRootPath(): string {
  return getUserDataPath('knowledge')
}

export function moduleAuthorizationsFilePath(): string {
  return getUserDataPath('module-authorizations.json')
}
