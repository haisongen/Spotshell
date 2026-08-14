import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSSHTools } from './tools.js';
import type { KnowledgeTargetQuestion } from './tools.js';
import type { SSHExecutor } from './types.js';

const executor: SSHExecutor = {
  execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, timedOut: false }),
  write: async () => true,
};

const question = {
  question: '这条 HDFS 结论写到哪里？',
  candidates: [
    { kind: 'environment', targetId: 'env-1', label: 'CDH 生产', reason: '环境事实' },
  ],
};

describe('ask_knowledge_target tool', () => {
  it('is absent without the capability (CLI unchanged)', () => {
    const names = createSSHTools(executor).map((t) => t.name);
    assert.ok(!names.includes('ask_knowledge_target'));
  });

  it('passes the question through and returns the host wording verbatim', async () => {
    const received: KnowledgeTargetQuestion[] = [];
    const tools = createSSHTools(executor, {
      askKnowledgeTarget: async (input) => {
        received.push(input);
        return '用户选择了落点 kind=environment targetId=env-1（CDH 生产）。';
      },
    });
    const tool = tools.find((t) => t.name === 'ask_knowledge_target');
    assert.ok(tool);
    const result = await tool!.invoke(question);
    assert.match(String(result), /targetId=env-1/);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0]?.candidates, question.candidates);
  });

  it('reports callback failures instead of throwing', async () => {
    const tools = createSSHTools(executor, {
      askKnowledgeTarget: async () => { throw new Error('boom'); },
    });
    const tool = tools.find((t) => t.name === 'ask_knowledge_target')!;
    assert.match(String(await tool.invoke(question)), /boom/);
  });
});
