import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OscParser } from './OscParser.js';

const OSC = '\u001b]6973;';
const BEL = '\u0007';

describe('OscParser', () => {
  it('parses a prompt marker (exit code + cwd)', () => {
    const p = new OscParser();
    const events = p.feed(`hello${OSC}D;0;/home/user${BEL}world`);
    assert.deepEqual(events, [{ type: 'prompt', exitCode: 0, cwd: '/home/user' }]);
  });

  it('parses a command marker', () => {
    const p = new OscParser();
    assert.deepEqual(p.feed(`${OSC}C;tail -f app.log${BEL}`), [
      { type: 'command', command: 'tail -f app.log' },
    ]);
  });

  it('keeps semicolons inside cwd intact', () => {
    const p = new OscParser();
    assert.deepEqual(p.feed(`${OSC}D;1;/tmp/a;b${BEL}`), [
      { type: 'prompt', exitCode: 1, cwd: '/tmp/a;b' },
    ]);
  });

  it('handles a sequence split across chunks (including a split prefix)', () => {
    const p = new OscParser();
    assert.deepEqual(p.feed(`abc\u001b]69`), []);
    assert.deepEqual(p.feed(`73;D;2;/va`), []);
    assert.deepEqual(p.feed(`r/log${BEL}tail`), [
      { type: 'prompt', exitCode: 2, cwd: '/var/log' },
    ]);
  });

  it('accepts ST (ESC \\) as terminator', () => {
    const p = new OscParser();
    assert.deepEqual(p.feed(`${OSC}C;ls\u001b\\`), [{ type: 'command', command: 'ls' }]);
  });

  it('parses multiple markers in one chunk', () => {
    const p = new OscParser();
    const events = p.feed(`${OSC}C;false${BEL}...${OSC}D;1;/root${BEL}`);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, 'command');
    assert.equal(events[1]!.type, 'prompt');
  });

  it('drops malformed bodies without throwing', () => {
    const p = new OscParser();
    assert.deepEqual(p.feed(`${OSC}D;notanumber${BEL}`), []);
    assert.deepEqual(p.feed(`${OSC}X;whatever${BEL}`), []);
  });

  it('discards an unterminated sequence that exceeds the pending cap', () => {
    const p = new OscParser();
    assert.deepEqual(p.feed(`${OSC}C;` + 'x'.repeat(5000)), []);
    // 超限后丢弃，后续正常序列不受影响
    assert.deepEqual(p.feed(`${BEL}${OSC}C;ok${BEL}`), [{ type: 'command', command: 'ok' }]);
  });
});
