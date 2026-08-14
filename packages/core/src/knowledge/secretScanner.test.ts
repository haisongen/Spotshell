import assert from 'node:assert/strict';
import test from 'node:test';
import { scanKnowledgeSecrets } from './secretScanner.js';

test('private key material produces a blocking result without exposing the secret', () => {
  const content = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'c3VwZXItc2VjcmV0LWtleQ==',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');

  const result = scanKnowledgeSecrets(content);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.findings, [{
    ruleId: 'private-key',
    disposition: 'block',
    line: 1,
    column: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /c3VwZXItc2VjcmV0LWtleQ/);

  for (const header of [
    '-----BEGIN ENCRYPTED PRIVATE KEY-----',
    '-----BEGIN PGP PRIVATE KEY BLOCK-----',
  ]) {
    assert.equal(scanKnowledgeSecrets(header).status, 'blocked');
  }
});

test('a high-confidence API token produces a blocking result', () => {
  const cases = [
    ['openai-api-key', `provider_token=sk-proj-${'a'.repeat(36)}`],
    ['github-token', `github_token=ghp_${'b'.repeat(36)}`],
    ['aws-access-key', `aws_access_key=AKIA${'C'.repeat(16)}`],
  ] as const;

  for (const [ruleId, content] of cases) {
    const result = scanKnowledgeSecrets(content);
    assert.equal(result.status, 'blocked', ruleId);
    assert.equal(result.findings[0]?.ruleId, ruleId);
    assert.equal(result.findings[0]?.disposition, 'block');
  }
});

test('password-like assignments are quarantined while redacted placeholders are clean', () => {
  const suspicious = scanKnowledgeSecrets('database_password=correct-horse-battery-staple');
  const redacted = scanKnowledgeSecrets('database_password=<REDACTED>');

  assert.equal(suspicious.status, 'quarantined');
  assert.equal(suspicious.findings[0]?.ruleId, 'password-like-assignment');
  assert.equal(suspicious.findings[0]?.disposition, 'quarantine');
  assert.deepEqual(redacted, { status: 'clean', findings: [] });
});
