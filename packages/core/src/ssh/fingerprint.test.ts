import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostKeyFingerprint } from './fingerprint.js';

describe('hostKeyFingerprint', () => {
  it('produces OpenSSH-style SHA256 fingerprints (deterministic, unpadded base64)', () => {
    const fp = hostKeyFingerprint(Buffer.from('key-bytes'));
    assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
    assert.equal(fp, hostKeyFingerprint(Buffer.from('key-bytes')));
    assert.notEqual(fp, hostKeyFingerprint(Buffer.from('other-key')));
  });
});
