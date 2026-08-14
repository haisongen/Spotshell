import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine } from './commandParse.js';

describe('parseCommandLine', () => {
  it('splits a simple command into argv', () => {
    const r = parseCommandLine('ls -la /tmp');
    assert.equal(r.opaque, false);
    assert.equal(r.segments.length, 1);
    assert.deepEqual(r.segments[0]!.argv, ['ls', '-la', '/tmp']);
    assert.equal(r.hasRedirect, false);
  });

  it('splits pipelines and lists into segments', () => {
    const r = parseCommandLine('cat a.log | grep ERROR && echo done; whoami');
    assert.equal(r.segments.length, 4);
    assert.deepEqual(r.segments.map((s) => s.argv[0]), ['cat', 'grep', 'echo', 'whoami']);
  });

  it('detects output redirection', () => {
    const r = parseCommandLine('echo hi > /etc/motd');
    assert.equal(r.hasRedirect, true);
  });

  it('marks command substitution as opaque (fail-closed)', () => {
    assert.equal(parseCommandLine('echo $(rm -rf /)').opaque, true);
    assert.equal(parseCommandLine('echo `whoami`').opaque, true);
  });

  it('marks unparseable input as opaque', () => {
    assert.equal(parseCommandLine('echo "unterminated').opaque, true);
  });

  it('treats empty input as empty, not opaque', () => {
    const r = parseCommandLine('   ');
    assert.equal(r.opaque, false);
    assert.equal(r.segments.length, 0);
  });
});
