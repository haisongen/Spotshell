import type { ConnectConfig } from 'ssh2';
import { hostKeyFingerprint } from './fingerprint.js';

export interface HostKeyInfo {
  /** OpenSSH-style SHA256 fingerprint, for example "SHA256:xxxx". */
  fingerprint: string;
}

export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: Buffer | string;
  passphrase?: string;
  /** SSH agent socket or Windows OpenSSH named pipe. */
  agent?: string;
  /** Return false to abort. Omit to preserve the legacy accept-any-key behavior. */
  hostVerifier?: (info: HostKeyInfo) => Promise<boolean>;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  /** null means no exit code was received (timeout, signal, etc.). */
  exitCode: number | null;
  signal?: string;
  durationMs: number;
  timedOut: boolean;
}

export interface SSHClientEvents {
  ready: () => void;
  error: (err: Error) => void;
  close: () => void;
  data: (data: Buffer) => void;
}

export function toSSH2Config(config: SSHConnectionConfig): ConnectConfig {
  const base: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    privateKey: config.privateKey,
    passphrase: config.passphrase,
    agent: config.agent,
  };

  if (config.hostVerifier) {
    const verify = config.hostVerifier;
    base.hostVerifier = ((key: Buffer, callback: (valid: boolean) => void): void => {
      void verify({ fingerprint: hostKeyFingerprint(key) })
        .then((ok) => callback(ok))
        .catch(() => callback(false));
    }) as ConnectConfig['hostVerifier'];
  }

  return base;
}
