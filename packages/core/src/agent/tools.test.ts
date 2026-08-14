import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SSHExecutor } from './types.js';
import { createSSHTools } from './tools.js';

function fakeExecutor(overrides: Partial<SSHExecutor> = {}): SSHExecutor {
  return {
    execute: async (command) => ({
      command, stdout: 'hello', stderr: '',
      exitCode: 0, durationMs: 2, timedOut: false,
    }),
    write: async () => true,
    ...overrides,
  };
}

describe('createSSHTools', () => {
  it('execute_ssh_command output ends with exit_code marker', async () => {
    const tools = createSSHTools(fakeExecutor());
    const execTool = tools.find((t) => t.name === 'execute_ssh_command')!;
    const out = await execTool.invoke({ command: 'ls' });
    assert.match(String(out), /\[exit_code=0\]$/);
  });

  it('write_to_terminal reports denial when write returns false', async () => {
    const tools = createSSHTools(fakeExecutor({ write: async () => false }));
    const writeTool = tools.find((t) => t.name === 'write_to_terminal')!;
    const out = await writeTool.invoke({ text: 'ls\n' });
    assert.match(String(out), /拒绝|失败/);
  });
});
