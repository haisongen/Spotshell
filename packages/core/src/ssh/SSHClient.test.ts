import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Client } from 'ssh2';
import { SSHClient } from './SSHClient.js';

function fakeStream(): any {
  const stream = new EventEmitter() as any;
  stream.stderr = new EventEmitter();
  stream.end = (): void => {};
  return stream;
}

function sshWithFakeExec(script: (command: string, stream: any) => void): SSHClient {
  const client = new EventEmitter() as any;
  client.exec = (
    command: string,
    _opts: unknown,
    cb: (err: Error | undefined, stream: any) => void
  ): void => {
    const stream = fakeStream();
    cb(undefined, stream);
    script(command, stream);
  };
  client.connect = (): void => {};
  client.end = (): void => {};
  client.destroy = (): void => {};
  const ssh = new SSHClient(client as Client);
  client.emit('ready');
  return ssh;
}

describe('SSHClient.execCommand', () => {
  it('returns structured result with separated stderr and exit code', async () => {
    const ssh = sshWithFakeExec((_cmd, stream) => {
      setImmediate(() => {
        stream.emit('data', Buffer.from('hello\n'));
        stream.stderr.emit('data', Buffer.from('warn\n'));
        stream.emit('exit', 0);
        stream.emit('close');
      });
    });
    const r = await ssh.execCommand('echo hello');
    assert.equal(r.stdout, 'hello');
    assert.equal(r.stderr, 'warn');
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.command, 'echo hello');
  });

  it('marks result as timed out and keeps partial output', async () => {
    const ssh = sshWithFakeExec((_cmd, stream) => {
      setImmediate(() => stream.emit('data', Buffer.from('partial')));
    });
    const r = await ssh.execCommand('sleep 100', 50);
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.equal(r.stdout, 'partial');
  });

  it('takes exit code from close event args when present', async () => {
    const ssh = sshWithFakeExec((_cmd, stream) => {
      setImmediate(() => {
        stream.emit('data', Buffer.from('x'));
        stream.emit('close', 2);
      });
    });
    const r = await ssh.execCommand('false');
    assert.equal(r.exitCode, 2);
  });
});
