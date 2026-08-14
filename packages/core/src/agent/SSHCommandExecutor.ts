import type { ClientChannel } from 'ssh2';
import type { SSHExecutor } from './types.js';
import { SSHClient } from '../ssh/SSHClient.js';
import type { CommandResult } from '../ssh/types.js';

export class SSHCommandExecutor implements SSHExecutor {
  private client: SSHClient;
  private stream: ClientChannel;
  private commandTimeout: number;

  constructor(client: SSHClient, stream: ClientChannel, timeout: number = 30000) {
    this.client = client;
    this.stream = stream;
    this.commandTimeout = timeout;
  }

  async execute(command: string): Promise<CommandResult> {
    return this.client.execCommand(command, this.commandTimeout);
  }

  async write(data: string): Promise<boolean> {
    if (this.stream && !this.stream.destroyed) {
      return this.stream.write(data);
    }
    return false;
  }

  updateStream(stream: ClientChannel): void {
    this.stream = stream;
  }
}
