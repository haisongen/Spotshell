export type SecretDisposition = 'block' | 'quarantine';

export interface SecretFinding {
  ruleId: string;
  disposition: SecretDisposition;
  line: number;
  column: number;
}

export interface SecretScanResult {
  status: 'clean' | 'blocked' | 'quarantined';
  findings: SecretFinding[];
}

interface SecretRule {
  id: string;
  disposition: SecretDisposition;
  pattern: RegExp;
}

const passwordAssignmentPattern = new RegExp(
  '^\\s*(?:[A-Za-z0-9-]+_password|password|passwd|token)\\s*[:=]\\s*' +
    '(?!["\']?<REDACTED>["\']?\\s*$)\\S+',
  'gim'
);

const secretRules: readonly SecretRule[] = [
  {
    id: 'openai-api-key',
    disposition: 'block',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'github-token',
    disposition: 'block',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: 'aws-access-key',
    disposition: 'block',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'private-key',
    disposition: 'block',
    pattern: /-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g,
  },
  {
    id: 'password-like-assignment',
    disposition: 'quarantine',
    pattern: passwordAssignmentPattern,
  },
];

export function scanKnowledgeSecrets(content: string): SecretScanResult {
  const findings: SecretFinding[] = [];
  for (const rule of secretRules) {
    for (const match of content.matchAll(rule.pattern)) {
      const index = match.index;
      if (index === undefined) continue;
      const position = positionAt(content, index);
      findings.push({
        ruleId: rule.id,
        disposition: rule.disposition,
        ...position,
      });
    }
  }
  findings.sort((left, right) => left.line - right.line || left.column - right.column);
  return {
    status: findings.some((finding) => finding.disposition === 'block')
      ? 'blocked'
      : findings.length > 0
        ? 'quarantined'
        : 'clean',
    findings,
  };
}

function positionAt(content: string, index: number): { line: number; column: number } {
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  const lastLineBreak = before.lastIndexOf('\n');
  return { line, column: index - lastLineBreak };
}
