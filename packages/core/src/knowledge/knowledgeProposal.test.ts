import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  buildProposalUnifiedDiff,
  cancelKnowledgeProposal,
  checkProposalBase,
  createKnowledgeProposal,
  editKnowledgeProposal,
  prepareAcceptKnowledgeProposal,
  proposalChangesGuidance,
  rejectKnowledgeProposal,
  type KnowledgeChangeProposal,
  type CreateKnowledgeProposalInput,
} from './knowledgeProposal.js';

const MODULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENV_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOST_ID = 'host-1';

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function baseInput(
  overrides: Partial<CreateKnowledgeProposalInput> = {},
): CreateKnowledgeProposalInput {
  const before = '---\nschema_version: 1\nid: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nkind: knowledge\nname: JVM\ndescription: jvm help\nwhen_to_use: jvm\n---\n\n# Notes\nold\n';
  const after = before.replace('old', 'new fact from diagnosis');
  return {
    id: 'proposal-1',
    targetKind: 'knowledge',
    targetId: MODULE_ID,
    targetName: 'JVM',
    baseRevision: 2,
    baseContentHash: hash(before),
    files: [{ relativePath: 'SPACE.md', before, after }],
    reason: 'Captured durable JVM restart tip',
    terminalEvidence: 'systemctl status app\n[exit_code=0]',
    knowledgeSources: [{
      objectId: MODULE_ID,
      objectName: 'JVM',
      objectKind: 'knowledge',
      revision: 2,
      contentHash: hash(before),
      relativePath: 'SPACE.md',
      startLine: 1,
      endLine: 12,
    }],
    createdAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
}

test('createKnowledgeProposal requires exactly one target and complete payload', () => {
  const ok = createKnowledgeProposal(baseInput());
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.proposal.status, 'pending');
  assert.equal(ok.proposal.promoteToGuidance, false);
  assert.equal(ok.proposal.files.length, 1);
  assert.equal(ok.proposal.targetKind, 'knowledge');

  const missingReason = createKnowledgeProposal(baseInput({ reason: '  ' }));
  assert.equal(missingReason.ok, false);

  const noFiles = createKnowledgeProposal(baseInput({ files: [] }));
  assert.equal(noFiles.ok, false);

  const unchanged = createKnowledgeProposal(baseInput({
    files: [{ relativePath: 'SPACE.md', before: 'a', after: 'a' }],
  }));
  assert.equal(unchanged.ok, false);
});

test('createKnowledgeProposal rejects multi-file path escape and empty target', () => {
  const escape = createKnowledgeProposal(baseInput({
    files: [{ relativePath: '../secret.txt', before: '', after: 'x' }],
  }));
  assert.equal(escape.ok, false);

  const emptyTarget = createKnowledgeProposal(baseInput({ targetId: '' }));
  assert.equal(emptyTarget.ok, false);
});

test('createKnowledgeProposal accepts host-notes and environment targets', () => {
  const host = createKnowledgeProposal(baseInput({
    targetKind: 'host-notes',
    targetId: HOST_ID,
    targetName: 'Host Notes',
    baseRevision: 1,
    baseContentHash: hash('old note'),
    files: [{ relativePath: 'notes', before: 'old note', after: 'old note\n\nnew tip' }],
    knowledgeSources: [],
  }));
  assert.equal(host.ok, true);

  const env = createKnowledgeProposal(baseInput({
    targetKind: 'environment',
    targetId: ENV_ID,
    targetName: 'Prod',
    files: [{
      relativePath: 'SPACE.md',
      before: '---\nschema_version: 1\nid: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\nkind: environment\nname: Prod\ndescription: prod env\nmodules:\n  always: []\n  on_demand: []\n---\n\nold\n',
      after: '---\nschema_version: 1\nid: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\nkind: environment\nname: Prod\ndescription: prod env\nmodules:\n  always: []\n  on_demand: []\n---\n\nnew log path\n',
    }],
  }));
  assert.equal(env.ok, true);
});

test('AI cannot enable promoteToGuidance; only user edit can', () => {
  const created = createKnowledgeProposal(baseInput({ promoteToGuidance: true }));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.proposal.promoteToGuidance, false);

  const edited = editKnowledgeProposal(created.proposal, { promoteToGuidance: true });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.proposal.promoteToGuidance, true);
});

test('editKnowledgeProposal allows content edits while pending only', () => {
  const created = createKnowledgeProposal(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const edited = editKnowledgeProposal(created.proposal, {
    reason: 'Updated reason',
    files: [{
      relativePath: 'SPACE.md',
      before: created.proposal.files[0]!.before,
      after: created.proposal.files[0]!.after.replace('new fact', 'edited fact'),
    }],
  });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.proposal.reason, 'Updated reason');
  assert.match(edited.proposal.files[0]!.after, /edited fact/);

  const cancelled = cancelKnowledgeProposal(created.proposal);
  const editCancelled = editKnowledgeProposal(cancelled, { reason: 'nope' });
  assert.equal(editCancelled.ok, false);
});

test('checkProposalBase and prepareAccept detect stale base without writing', () => {
  const created = createKnowledgeProposal(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const proposal = created.proposal;

  assert.equal(
    checkProposalBase(proposal, {
      revision: proposal.baseRevision,
      contentHash: proposal.baseContentHash,
    }),
    'ok',
  );
  assert.equal(
    checkProposalBase(proposal, {
      revision: proposal.baseRevision + 1,
      contentHash: 'different',
    }),
    'stale',
  );

  const ready = prepareAcceptKnowledgeProposal(proposal, {
    revision: proposal.baseRevision,
    contentHash: proposal.baseContentHash,
  });
  assert.equal(ready.ok, true);

  const conflict = prepareAcceptKnowledgeProposal(proposal, {
    revision: 99,
    contentHash: 'changed',
  });
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.reason, 'stale');
  assert.equal(conflict.proposal.status, 'conflict');
  assert.equal(conflict.proposal.conflict?.currentRevision, 99);
});

test('proposalChangesGuidance detects Guidance elevation', () => {
  const before = '---\nschema_version: 1\nid: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nkind: knowledge\nname: JVM\ndescription: jvm help\nwhen_to_use: jvm\n---\n\n# Notes\nref only\n';
  const afterWithGuidance = `${before}\n## Guidance\nAlways restart carefully\n`;
  assert.equal(
    proposalChangesGuidance([{ relativePath: 'SPACE.md', before, after: afterWithGuidance }]),
    true,
  );
  assert.equal(
    proposalChangesGuidance([{ relativePath: 'SPACE.md', before, after: before.replace('ref only', 'updated ref') }]),
    false,
  );
});

test('prepareAccept refuses Guidance elevation without explicit user promotion', () => {
  const before = '---\nschema_version: 1\nid: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nkind: knowledge\nname: JVM\ndescription: jvm help\nwhen_to_use: jvm\n---\n\n# Notes\nref only\n';
  const after = `${before}\n## Guidance\nAlways restart carefully\n`;
  const created = createKnowledgeProposal(baseInput({
    baseContentHash: hash(before),
    files: [{ relativePath: 'SPACE.md', before, after }],
  }));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const denied = prepareAcceptKnowledgeProposal(created.proposal, {
    revision: created.proposal.baseRevision,
    contentHash: created.proposal.baseContentHash,
  });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.reason, 'guidance-promotion-required');

  const promoted = editKnowledgeProposal(created.proposal, { promoteToGuidance: true });
  assert.equal(promoted.ok, true);
  if (!promoted.ok) return;
  const accepted = prepareAcceptKnowledgeProposal(promoted.proposal, {
    revision: promoted.proposal.baseRevision,
    contentHash: promoted.proposal.baseContentHash,
  });
  assert.equal(accepted.ok, true);
});

/**
 * Shape of the real user knowledge modules that triggered the false
 * `guidance-promotion-required`: `##Foo` written without the space CommonMark
 * needs, so remark sees paragraphs and nothing terminates `## Guidance`.
 */
const SPACELESS_HEADING_SPACE = [
  '---',
  'schema_version: 1',
  'id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'kind: knowledge',
  'name: Ambari',
  'description: ambari ops',
  'when_to_use: ambari',
  '---',
  '',
  '# Ambari 相关操作',
  '',
  '## Guidance',
  '',
  '- 执行前先确认集群状态',
  '',
  '```bash',
  '## 这行在代码块里，不是标题',
  '#!/bin/bash',
  '```',
  '',
  '仍然属于 Guidance 的补充说明',
  '',
  '##Hadoop 日志报错巡检（HDP）',
  '',
  '巡检步骤一',
  '',
  '###mysql 登录信息',
  '',
  '登录说明',
  '',
].join('\n');

test('appending after a spaceless ## heading is not a Guidance change', () => {
  const before = SPACELESS_HEADING_SPACE;
  const after = `${before}\n##Consul 服务巡检\n\n新追加的巡检步骤\n`;
  assert.equal(
    proposalChangesGuidance([{ relativePath: 'SPACE.md', before, after }]),
    false,
  );

  const created = createKnowledgeProposal(baseInput({
    baseContentHash: hash(before),
    files: [{ relativePath: 'SPACE.md', before, after }],
  }));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const ready = prepareAcceptKnowledgeProposal(created.proposal, {
    revision: created.proposal.baseRevision,
    contentHash: created.proposal.baseContentHash,
  });
  assert.equal(ready.ok, true, 'appending unrelated content must not need Guidance promotion');
});

test('a spaceless ## heading does not hide real Guidance edits', () => {
  const before = SPACELESS_HEADING_SPACE;
  assert.equal(
    proposalChangesGuidance([{
      relativePath: 'SPACE.md',
      before,
      after: before.replace('- 执行前先确认集群状态', '- 执行前必须先 kinit'),
    }]),
    true,
  );
  // Everything up to the first spaceless heading is still Guidance, including
  // the prose sitting behind the fenced code block.
  assert.equal(
    proposalChangesGuidance([{
      relativePath: 'SPACE.md',
      before,
      after: before.replace('仍然属于 Guidance 的补充说明', '改写后的补充说明'),
    }]),
    true,
  );
  // A `##` line inside a fence is code, not a section boundary.
  assert.equal(
    proposalChangesGuidance([{
      relativePath: 'SPACE.md',
      before,
      after: before.replace('## 这行在代码块里，不是标题', '## 改过的注释'),
    }]),
    true,
  );
});

test('a deeper spaceless heading does not end Guidance', () => {
  const before = [
    '---',
    'schema_version: 1',
    'id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'kind: knowledge',
    'name: Ambari',
    'description: ambari ops',
    'when_to_use: ambari',
    '---',
    '',
    '## Guidance',
    '',
    '###mysql 登录信息',
    '',
    '登录说明',
    '',
  ].join('\n');
  // `###Foo` mirrors a real `### Foo`, which was never a peer boundary either.
  assert.equal(
    proposalChangesGuidance([{
      relativePath: 'SPACE.md',
      before,
      after: before.replace('登录说明', '改写后的登录说明'),
    }]),
    true,
  );
});

test('cancel and reject leave proposal non-writable', () => {
  const created = createKnowledgeProposal(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const cancelled = cancelKnowledgeProposal(created.proposal);
  assert.equal(cancelled.status, 'cancelled');
  const acceptCancelled = prepareAcceptKnowledgeProposal(cancelled, {
    revision: cancelled.baseRevision,
    contentHash: cancelled.baseContentHash,
  });
  assert.equal(acceptCancelled.ok, false);

  const rejected = rejectKnowledgeProposal(created.proposal);
  assert.equal(rejected.status, 'rejected');
});

test('edit and prepareAccept allow recovery from validation-failed', () => {
  const created = createKnowledgeProposal(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const failed = {
    ...created.proposal,
    status: 'validation-failed' as const,
    validationError: 'possible secret',
  };
  const edited = editKnowledgeProposal(failed, {
    files: [{
      relativePath: 'SPACE.md',
      before: failed.files[0]!.before,
      after: failed.files[0]!.after.replace('new fact', 'clean fact'),
    }],
  });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.proposal.status, 'pending');
  const ready = prepareAcceptKnowledgeProposal(edited.proposal, {
    revision: edited.proposal.baseRevision,
    contentHash: edited.proposal.baseContentHash,
  });
  assert.equal(ready.ok, true);
});

test('buildProposalUnifiedDiff formats a reviewable diff', () => {
  const proposal: KnowledgeChangeProposal = {
    id: 'p1',
    targetKind: 'host-notes',
    targetId: HOST_ID,
    targetName: 'Host Notes',
    baseRevision: 1,
    baseContentHash: 'h',
    files: [{ relativePath: 'notes', before: 'a\n', after: 'a\nb\n' }],
    reason: 'r',
    terminalEvidence: 'e',
    knowledgeSources: [],
    promoteToGuidance: false,
    status: 'pending',
    createdAt: '2026-08-06T00:00:00.000Z',
  };
  const diff = buildProposalUnifiedDiff(proposal);
  assert.match(diff, /--- a\/notes/);
  assert.match(diff, /\+b/);
});
