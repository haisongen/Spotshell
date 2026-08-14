import { Client, ClientChannel } from 'ssh2';
import { EventEmitter } from 'events';
import { SSHConnectionConfig, toSSH2Config, CommandResult } from './types.js';

export class SSHClient extends EventEmitter {
  private client: Client;
  private stream: ClientChannel | null = null;
  private connected: boolean = false;

  constructor(client?: Client) {
    super();
    this.client = client ?? new Client();
    this.setupClientEvents();
  }

  private setupClientEvents(): void {
    this.client.on('ready', () => {
      this.connected = true;
      this.emit('ready');
    });

    this.client.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.client.on('close', () => {
      this.connected = false;
      this.stream = null;
      this.emit('close');
    });

    this.client.on('end', () => {
      this.connected = false;
      this.stream = null;
      this.emit('end');
    });
  }

  connect(config: SSHConnectionConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.client.removeListener('ready', onReady);
        this.client.removeListener('error', onError);
      };

      this.client.once('ready', onReady);
      this.client.once('error', onError);
      this.client.connect(toSSH2Config(config));
    });
  }

  requestShell(
    cols: number = 80,
    rows: number = 24
  ): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('SSH client is not connected'));
        return;
      }

      this.client.shell(
        {
          term: process.env['TERM'] || 'xterm-256color',
          cols,
          rows,
        },
        (err, stream) => {
          if (err) {
            reject(err);
            return;
          }

          this.stream = stream;

          stream.on('close', () => {
            this.emit('shell:close');
          });

          stream.on('data', (data: Buffer) => {
            this.emit('data', data);
          });

          stream.stderr.on('data', (data: Buffer) => {
            this.emit('stderr', data);
          });

          resolve(stream);
        }
      );
    });
  }

  execCommand(command: string, timeout: number = 30000): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('SSH client is not connected'));
        return;
      }

      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let signal: string | undefined;
      let finished = false;
      let timedOut = false;
      let timeoutId: NodeJS.Timeout | null = null;

      this.client.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        const finish = (): void => {
          if (finished) return;
          finished = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          stream.removeAllListeners();
          stream.stderr.removeAllListeners();
          resolve({
            command,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode,
            signal,
            durationMs: Date.now() - startedAt,
            timedOut,
          });
        };

        stream.on('data', (data: Buffer) => {
          stdout += data.toString('utf-8');
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf-8');
        });

        stream.on('exit', (code: number | null, sig?: string) => {
          exitCode = code ?? null;
          signal = sig ?? undefined;
        });

        stream.on('error', (streamErr: Error) => {
          if (!finished) {
            reject(streamErr);
          }
        });

        stream.on('close', (code?: number | null, sig?: string) => {
          if (typeof code === 'number') exitCode = code;
          if (typeof sig === 'string') signal = sig;
          finish();
        });

        timeoutId = setTimeout(() => {
          timedOut = true;
          stream.end();
          finish();
        }, timeout);
      });
    });
  }

  getStream(): ClientChannel | null {
    return this.stream;
  }

  isConnected(): boolean {
    return this.connected;
  }

  resizeWindow(cols: number, rows: number): void {
    if (this.stream) {
      this.stream.setWindow(rows, cols, 0, 0);
    }
  }

  write(data: string | Buffer): boolean {
    if (this.stream && !this.stream.destroyed) {
      return this.stream.write(data);
    }
    return false;
  }

  disconnect(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    this.client.end();
    this.connected = false;
  }

  destroy(): void {
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    this.client.destroy();
    this.connected = false;
  }
}
