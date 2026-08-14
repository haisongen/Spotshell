import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSSHTools, shellQuoteArg } from './tools.js';
import { classifyCommand } from './risk.js';
import type { SSHExecutor } from './types.js';
import type { CommandResult } from '../ssh/types.js';

function fakeExecutor(): { executor: SSHExecutor; commands: string[] } {
  const commands: string[] = [];
  const result: CommandResult = {
    stdout: 'line1\nline2', stderr: '', exitCode: 0, durationMs: 5, timedOut: false,
  };
  return {
    commands,
    executor: {
      execute: async (command: string) => { commands.push(command); return result; },
      write: async () => true,
    },
  };
}

function getTool(executor: SSHExecutor, name: string) {
  const tool = createSSHTools(executor).find((t) => t.name === name);
  assert.ok(tool, `tool ${name} missing`);
  return tool!;
}

describe('shellQuoteArg', () => {
  it('single-quotes and escapes embedded quotes', () => {
    assert.equal(shellQuoteArg('/var/log/app.log'), `'/var/log/app.log'`);
    assert.equal(shellQuoteArg(`it's`), `'it'\\''s'`);
    assert.equal(shellQuoteArg('a b;rm -rf /'), `'a b;rm -rf /'`);
  });
});

describe('read_remote_file', () => {
  it('reads whole file capped by maxBytes, path quoted', async () => {
    const { executor, commands } = fakeExecutor();
    await getTool(executor, 'read_remote_file').invoke({ path: '/var/log/my app.log' });
    assert.equal(commands.length, 1);
    assert.match(commands[0]!, /^head -c 8192 -- '\/var\/log\/my app\.log'$/);
  });

  it('reads a line range via sed', async () => {
    const { executor, commands } = fakeExecutor();
    await getTool(executor, 'read_remote_file').invoke({
      path: '/etc/nginx/nginx.conf', startLine: 10, endLine: 40,
    });
    assert.match(commands[0]!, /^sed -n '10,40p' -- '\/etc\/nginx\/nginx\.conf' \| head -c 8192$/);
  });

  it('open-ended range uses $ (quoted against shell expansion)', async () => {
    const { executor, commands } = fakeExecutor();
    await getTool(executor, 'read_remote_file').invoke({ path: '/x', startLine: 100 });
    assert.match(commands[0]!, /sed -n '100,\$p'/);
  });

  it('caps maxBytes at 65536', async () => {
    const { executor, commands } = fakeExecutor();
    await getTool(executor, 'read_remote_file').invoke({ path: '/x', maxBytes: 999999 });
    assert.match(commands[0]!, /head -c 65536/);
  });
});

describe('grep_remote_logs', () => {
  it('builds a bounded grep with quoted pattern and path', async () => {
    const { executor, commands } = fakeExecutor();
    await getTool(executor, 'grep_remote_logs').invoke({
      path: '/var/log/messages', pattern: 'GSS initiate failed',
    });
    assert.match(
      commands[0]!,
      /^grep -n -m 100 -e 'GSS initiate failed' -- '\/var\/log\/messages' \| head -c 16384$/
    );
  });

  it('supports ignoreCase and custom maxMatches', async () => {
    const { executor, commands } = fakeExecutor();
    await getTool(executor, 'grep_remote_logs').invoke({
      path: '/x.log', pattern: 'error', ignoreCase: true, maxMatches: 20,
    });
    assert.match(commands[0]!, /^grep -n -i -m 20 -e 'error' -- '\/x\.log'/);
  });
});

describe('generated commands stay readonly (policy safety fuse)', () => {
  it('quotes, spaces and semicolons in inputs still classify readonly', async () => {
    const { executor, commands } = fakeExecutor();
    await getTool(executor, 'read_remote_file').invoke({ path: `/tmp/a b'; reboot; '.log` });
    await getTool(executor, 'grep_remote_logs').invoke({
      path: '/a', pattern: `'; rm -rf / #`,
    });
    for (const cmd of commands) {
      assert.equal(classifyCommand(cmd), 'readonly', cmd);
    }
  });

  it('inputs containing $( fall back to fail-closed destructive (never auto-runs a mutation)', async () => {
    const { executor, commands } = fakeExecutor();
    await getTool(executor, 'read_remote_file').invoke({ path: '/tmp/$(rm -rf /)' });
    // 引号已让内容成为字面量，但 commandParse 的字符串级预检对 $( 一律 opaque
    // （Phase 1 fail-closed 决策）→ destructive → 该工具调用会被拒绝/要求确认，绝不会静默执行。
    assert.equal(classifyCommand(commands[0]!), 'destructive');
  });
});
