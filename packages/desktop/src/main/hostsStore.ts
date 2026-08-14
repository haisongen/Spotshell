import { safeStorage } from 'electron'
import { HostStore } from '@spotshell/core'
import { HostCredentialStore, type CredentialCipher } from './HostCredentialStore'
import { hostCredentialsFilePath, hostsFilePath } from './paths'

export const hostStore = new HostStore(hostsFilePath())

const safeStorageCipher: CredentialCipher = {
  encrypt(value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure password storage is not available on this system')
    }
    return safeStorage.encryptString(value)
  },
  decrypt(value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure password storage is not available on this system')
    }
    return safeStorage.decryptString(value)
  },
}

export const hostCredentialStore = new HostCredentialStore(
  hostCredentialsFilePath(),
  safeStorageCipher
)

export function appendHostNote(hostId: string, note: string): string {
  const stamp = new Date().toISOString().slice(0, 10)
  try {
    const updated = hostStore.appendNote(hostId, note, stamp)
    return updated ? '已保存到主机档案' : '主机备注已达 4000 字符上限，未保存（请先在主机档案里清理）'
  } catch (err) {
    return `保存失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Replace Host Notes with the full reviewed proposal body. */
export function setHostNotes(hostId: string, notes: string): string {
  try {
    const normalized = notes.trim()
    hostStore.update(hostId, { notes: normalized || undefined })
    return '已保存到主机档案'
  } catch (err) {
    return `保存失败: ${err instanceof Error ? err.message : String(err)}`
  }
}
