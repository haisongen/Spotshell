import { createHash } from 'node:crypto';

/** Return an OpenSSH-style SHA256 host-key fingerprint. */
export function hostKeyFingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}
