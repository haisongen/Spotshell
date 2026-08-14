import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSSHTools } from './tools.js';
import type { SSHExecutor } from './types.js';
import { buildSystemPrompt } from './prompt.js';

const executor: SSHExecutor = {
  execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, timedOut: false }),
  write: async () => true,
};

describe('propose_knowledge_change tool', () => {
  it('is absent without the capability', () => {
    const names = createSSHTools(executor).map((tool) => tool.name);
    assert.ok(!names.includes('propose_knowledge_change'));
  });

  it('forwards a single-target proposal to the host callback', async () => {
    const received: unknown[] = [];
    const tools = createSSHTools(executor, {
      proposeKnowledgeChange: async (request) => {
        received.push(request);
        return '用户已接受提案并创建修订 2';
      },
    });
    const tool = tools.find((entry) => entry.name === 'propose_knowledge_change');
    assert.ok(tool);
    const result = await tool!.invoke({
      targetKind: 'knowledge',
      targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      reason: 'Captured restart tip',
      terminalEvidence: 'systemctl status app\n[exit_code=0]',
      files: [{ relativePath: 'SPACE.md', after: '---\nnew\n' }],
    });
    assert.equal(result, '用户已接受提案并创建修订 2');
    assert.equal((received[0] as { targetKind: string }).targetKind, 'knowledge');
  });

  it('reports callback failures without throwing', async () => {
    const tools = createSSHTools(executor, {
      proposeKnowledgeChange: async () => {
        throw new Error('boom');
      },
    });
    const tool = tools.find((entry) => entry.name === 'propose_knowledge_change')!;
    const result = await tool.invoke({
      targetKind: 'host-notes',
      targetId: 'host-1',
      reason: 'note',
      files: [{ relativePath: 'notes', after: 'x' }],
    });
    assert.match(String(result), /boom/);
  });
});

describe('buildSystemPrompt knowledgeProposalTool option', () => {
  it('mentions propose_knowledge_change and forbids direct writes', () => {
    assert.doesNotMatch(buildSystemPrompt('zh-CN'), /propose_knowledge_change/);
    const zh = buildSystemPrompt('zh-CN', { knowledgeProposalTool: true });
    assert.match(zh, /propose_knowledge_change/);
    assert.match(zh, /不能直接写入|只能提案/);
    const en = buildSystemPrompt('en', { knowledgeProposalTool: true });
    assert.match(en, /propose_knowledge_change/);
    assert.match(en, /never direct writes|proposals only/i);
  });

  it('requires asking the user environment vs knowledge module before proposing', () => {
    const zh = buildSystemPrompt('zh-CN', { knowledgeProposalTool: true });
    assert.match(zh, /先用自然语言问用户落在哪里|先问用户/);
    assert.match(zh, /环境档案/);
    assert.match(zh, /知识模块/);
    assert.match(zh, /用户未明确选择目标前，禁止调用/);
    const en = buildSystemPrompt('en', { knowledgeProposalTool: true });
    assert.match(en, /first ask the user/i);
    assert.match(en, /Environment profile/i);
    assert.match(en, /Knowledge module/i);
    assert.match(en, /Do not call propose_knowledge_change/);
  });
});
