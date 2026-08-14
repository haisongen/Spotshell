import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContextBuffer } from './ContextBuffer.js';

describe('ContextBuffer', () => {
  it('stores clean lines and respects maxLines', async () => {
    const buf = new ContextBuffer({ maxLines: 3, maxSize: 10000 });
    await buf.append('line1\nline2\nline3\nline4\n');
    assert.equal(buf.getLineCount(), 3);
    assert.equal(buf.getContext(), 'line2\nline3\nline4');
  });

  it('getRecentContext returns newest content within char budget', async () => {
    const buf = new ContextBuffer();
    await buf.append('aaaa\nbbbb\ncccc\n');
    const recent = buf.getRecentContext(10);
    assert.ok(recent.includes('cccc'));
    assert.ok(recent.length <= 12);
  });

  it('detects last error patterns', async () => {
    const buf = new ContextBuffer();
    await buf.append('ok\nError: boom\n');
    assert.match(buf.getLastError() ?? '', /Error: boom/);
  });
});

async function bufferWith(lines: string[]): Promise<ContextBuffer> {
  const buf = new ContextBuffer();
  await buf.append(lines.join('\n'));
  return buf;
}

describe('ContextBuffer.getLastCommand', () => {
  it('matches real-world prompts', async () => {
    const cases: Array<[string, string]> = [
      ['[user@host ~]$ ls -la /tmp', 'ls -la /tmp'],
      ['user@host:~/app$ tail -f app.log', 'tail -f app.log'],
      ['root@prod-01:/etc# systemctl status nginx', 'systemctl status nginx'],
      ['$ echo hi', 'echo hi'],
      ['> echo hi', 'echo hi'],
    ];
    for (const [line, expected] of cases) {
      const buf = await bufferWith(['some output', line]);
      assert.equal(buf.getLastCommand(), expected, line);
    }
  });

  it('ignores plain output lines containing # or $', async () => {
    const buf = await bufferWith([
      'PRICE IS $5 TOTAL',
      'config line # trailing comment',
      'Job finished OK',
    ]);
    assert.equal(buf.getLastCommand(), undefined);
  });

  it('skips the shell-integration injection echo', async () => {
    const buf = await bufferWith([
      'user@host:~$ tail -n 5 x.log',
      'user@host:~$  [ -n "$BASH_VERSION" ] && { __spotshell_prompt() ...',
    ]);
    assert.equal(buf.getLastCommand(), 'tail -n 5 x.log');
  });

  it('returns the most recent command', async () => {
    const buf = await bufferWith([
      'user@host:~$ first',
      'output',
      'user@host:~$ second',
      'more output',
    ]);
    assert.equal(buf.getLastCommand(), 'second');
  });
});
