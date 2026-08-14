import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ShellIntegration, SHELL_INTEGRATION_SNIPPET } from './ShellIntegration.js';

const OSC = '\u001b]6973;';
const BEL = '\u0007';

describe('ShellIntegration', () => {
  it('is inactive until the first prompt marker arrives', () => {
    const s = new ShellIntegration();
    assert.equal(s.active, false);
    s.feed(`${OSC}D;0;/root${BEL}`);
    assert.equal(s.active, true);
  });

  it('tracks cwd, last exit code and last command', () => {
    const s = new ShellIntegration();
    s.feed(`${OSC}D;0;/root${BEL}`);          // 首个提示符
    s.feed(`${OSC}C;cd /var/log${BEL}`);      // 用户命令
    s.feed(`${OSC}D;0;/var/log${BEL}`);       // 下一个提示符
    s.feed(`${OSC}C;grep ERROR app.log${BEL}`);
    s.feed(`${OSC}D;1;/var/log${BEL}`);
    assert.equal(s.cwd, '/var/log');
    assert.equal(s.lastExitCode, 1);
    assert.equal(s.lastCommand, 'grep ERROR app.log');
  });

  it('tracks whether a marked terminal command is still running', () => {
    const s = new ShellIntegration();
    assert.equal(s.commandRunning, false);
    s.feed(`${OSC}D;0;/root${BEL}`);
    s.feed(`${OSC}C;tail -f app.log${BEL}`);
    assert.equal(s.commandRunning, true);
    s.feed(`${OSC}D;130;/root${BEL}`);
    assert.equal(s.commandRunning, false);
  });

  it('resets command markers for a new Agent epoch while keeping cwd and active state', () => {
    const s = new ShellIntegration();
    s.feed(`${OSC}D;0;/var/log${BEL}`);
    s.feed(`${OSC}C;grep ERROR app.log${BEL}`);
    s.feed(`${OSC}D;1;/var/log${BEL}`);
    s.resetAgentEphemeralContext();
    assert.equal(s.active, true);
    assert.equal(s.cwd, '/var/log');
    assert.equal(s.lastCommand, undefined);
    assert.equal(s.lastExitCode, undefined);
    assert.equal(s.commandRunning, false);
  });

  it('accepts Buffer input and survives multi-byte UTF-8 split across chunks', () => {
    const s = new ShellIntegration();
    const full = Buffer.from(`${OSC}D;0;/home/用户${BEL}`, 'utf8');
    // 故意在多字节字符中间切开
    s.feed(full.subarray(0, full.length - 5));
    s.feed(full.subarray(full.length - 5));
    assert.equal(s.cwd, '/home/用户');
  });
});

describe('SHELL_INTEGRATION_SNIPPET', () => {
  it('is a single line guarded for bash only', () => {
    assert.match(SHELL_INTEGRATION_SNIPPET, /^\s\[ -n "\$BASH_VERSION" \] && /);
    assert.ok(SHELL_INTEGRATION_SNIPPET.endsWith('\n'));
    assert.equal(SHELL_INTEGRATION_SNIPPET.slice(0, -1).includes('\n'), false);
  });

  it('emits both D and C markers with the 6973 namespace', () => {
    assert.match(SHELL_INTEGRATION_SNIPPET, /6973;D;%s;%s/);
    assert.match(SHELL_INTEGRATION_SNIPPET, /6973;C;%s/);
  });
});
