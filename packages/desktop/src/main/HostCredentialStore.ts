import fs from 'node:fs'
import path from 'node:path'

export interface CredentialCipher {
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface CredentialFileShape {
  version: 1
  passwords: Record<string, string>
}

export class HostCredentialStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: CredentialCipher
  ) {}

  has(hostId: string): boolean {
    return Boolean(this.read().passwords[hostId])
  }

  get(hostId: string): string | undefined {
    const encoded = this.read().passwords[hostId]
    if (!encoded) return undefined
    try {
      return this.cipher.decrypt(Buffer.from(encoded, 'base64')) || undefined
    } catch {
      return undefined
    }
  }

  set(hostId: string, password: string): void {
    if (!password) {
      this.remove(hostId)
      return
    }
    const data = this.read()
    data.passwords[hostId] = this.cipher.encrypt(password).toString('base64')
    this.write(data)
  }

  remove(hostId: string): void {
    const data = this.read()
    if (!(hostId in data.passwords)) return
    delete data.passwords[hostId]
    this.write(data)
  }

  private read(): CredentialFileShape {
    if (!fs.existsSync(this.filePath)) return { version: 1, passwords: {} }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<CredentialFileShape>
      return {
        version: 1,
        passwords:
          parsed.passwords && typeof parsed.passwords === 'object'
            ? Object.fromEntries(
                Object.entries(parsed.passwords).filter(
                  ([hostId, value]) => Boolean(hostId) && typeof value === 'string'
                )
              )
            : {},
      }
    } catch {
      return { version: 1, passwords: {} }
    }
  }

  private write(data: CredentialFileShape): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}
