import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toSSH2Config } from './types.js';

describe('toSSH2Config hostVerifier', () => {
  it('is absent when config has no hostVerifier', () => {
    const cfg = toSSH2Config({ host: 'h', port: 22, username: 'u' });
    assert.equal(cfg.hostVerifier, undefined);
  });

  it('passes SHA256 fingerprint to the app-level verifier and forwards the verdict', async () => {
    const seen: string[] = [];
    const cfg = toSSH2Config({
      host: 'h',
      port: 22,
      username: 'u',
      hostVerifier: async (info) => {
        seen.push(info.fingerprint);
        return true;
      },
    });
    const verifier = cfg.hostVerifier as (key: Buffer, cb: (ok: boolean) => void) => void;
    const ok = await new Promise<boolean>((resolve) => verifier(Buffer.from('key'), resolve));
    assert.equal(ok, true);
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /^SHA256:/);
  });

  it('fails closed when the app-level verifier throws', async () => {
    const cfg = toSSH2Config({
      host: 'h',
      port: 22,
      username: 'u',
      hostVerifier: async () => {
        throw new Error('boom');
      },
    });
    const verifier = cfg.hostVerifier as (key: Buffer, cb: (ok: boolean) => void) => void;
    const ok = await new Promise<boolean>((resolve) => verifier(Buffer.from('key'), resolve));
    assert.equal(ok, false);
  });
});

describe('toSSH2Config agent authentication', () => {
  it('forwards an SSH agent socket to ssh2', () => {
    const cfg = toSSH2Config({
      host: 'h', port: 22, username: 'u', agent: '/tmp/ssh-agent.sock',
    });
    assert.equal(cfg.agent, '/tmp/ssh-agent.sock');
  });
});
