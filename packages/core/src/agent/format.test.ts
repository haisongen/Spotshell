import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatCommandResult } from './format.js';

describe('formatCommandResult', () => {
  it('formats stdout, stderr and exit code', () => {
    const text = formatCommandResult({
      command: 'x', stdout: 'out', stderr: 'warn',
      exitCode: 0, durationMs: 5, timedOut: false,
    });
    assert.equal(text, 'out\n[stderr]\nwarn\n[exit_code=0]');
  });

  it('marks timeouts and unknown exit codes', () => {
    const text = formatCommandResult({
      command: 'x', stdout: '', stderr: '',
      exitCode: null, durationMs: 30000, timedOut: true,
    });
    assert.equal(text, '[timed_out after 30000ms]');
  });

  it('omits stderr section when empty', () => {
    const text = formatCommandResult({
      command: 'x', stdout: 'ok', stderr: '',
      exitCode: 1, durationMs: 3, timedOut: false,
    });
    assert.equal(text, 'ok\n[exit_code=1]');
  });
});
