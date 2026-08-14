import fs from 'node:fs'
import path from 'node:path'

interface KnownHostsFile {
  hosts: Record<string, { fingerprint: string; firstSeenAt: string }>
}

/** Store trusted host fingerprints by host:port for TOFU verification. */
export class KnownHostsStore {
  constructor(private filePath: string) {}

  get(host: string, port: number): string | undefined {
    return this.read().hosts[this.key(host, port)]?.fingerprint
  }

  set(host: string, port: number, fingerprint: string): void {
    const data = this.read()
    data.hosts[this.key(host, port)] = {
      fingerprint,
      firstSeenAt: new Date().toISOString(),
    }
    this.write(data)
  }

  remove(host: string, port: number): void {
    const data = this.read()
    delete data.hosts[this.key(host, port)]
    this.write(data)
  }

  private key(host: string, port: number): string {
    return `${host}:${port}`
  }

  private read(): KnownHostsFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as KnownHostsFile
      return { hosts: parsed.hosts ?? {} }
    } catch {
      return { hosts: {} }
    }
  }

  private write(data: KnownHostsFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}
