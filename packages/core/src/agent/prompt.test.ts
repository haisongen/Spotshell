import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildContextMessage } from './prompt.js';

describe('buildSystemPrompt', () => {
  it('defaults to Chinese and mentions the file tools', () => {
    const zh = buildSystemPrompt();
    assert.match(zh, /你是 SpotShell/);
    assert.match(zh, /read_remote_file/);
    assert.match(zh, /grep_remote_logs/);
    assert.match(zh, /exit_code/);
  });

  it('returns an English prompt for en', () => {
    const en = buildSystemPrompt('en');
    assert.match(en, /You are SpotShell/);
    assert.match(en, /read_remote_file/);
    assert.doesNotMatch(en, /你是/);
  });
});

describe('buildSystemPrompt noteTool option', () => {
  it('mentions propose_host_note only when enabled', () => {
    assert.doesNotMatch(buildSystemPrompt('zh-CN'), /propose_host_note/);
    assert.match(buildSystemPrompt('zh-CN', { noteTool: true }), /propose_host_note/);
    assert.match(buildSystemPrompt('en', { noteTool: true }), /propose_host_note/);
  });
});

describe('buildSystemPrompt knowledgeTools option', () => {
  it('mentions knowledge tools only when enabled', () => {
    assert.doesNotMatch(buildSystemPrompt('zh-CN'), /list_knowledge_catalog/);
    assert.match(
      buildSystemPrompt('zh-CN', { knowledgeTools: true }),
      /list_knowledge_catalog/
    );
    assert.match(
      buildSystemPrompt('zh-CN', { knowledgeTools: true }),
      /select_knowledge_module/
    );
    assert.match(
      buildSystemPrompt('en', { knowledgeTools: true }),
      /read_knowledge_lines/
    );
    assert.match(
      buildSystemPrompt('en', { knowledgeTools: true }),
      /same tool loop/
    );
  });
});

describe('buildContextMessage', () => {
  it('renders host notes first, then shell state, localized', () => {
    const zh = buildContextMessage(
      {
        terminalHistory: 'tail: no such file',
        lastCommand: 'tail x.log',
        lastExitCode: 1,
        currentDirectory: '/var/log',
        hostNotes: 'CDH 6.3 集群，Kerberos 认证',
      },
      'zh-CN'
    );
    assert.match(zh, /\[主机档案备注\]\nCDH 6\.3 集群/);
    assert.ok(zh.indexOf('主机档案备注') < zh.indexOf('当前目录'));
    assert.match(zh, /当前目录: \/var\/log/);
    assert.match(zh, /最后执行的命令: tail x\.log/);
    assert.match(zh, /退出码: 1/);

    const en = buildContextMessage({ terminalHistory: 'hi', lastExitCode: 0 }, 'en');
    assert.match(en, /Last exit code: 0/);
    assert.match(en, /Terminal history/);
  });

  it('omits empty sections', () => {
    const msg = buildContextMessage({ terminalHistory: '' }, 'zh-CN');
    assert.doesNotMatch(msg, /主机档案备注/);
    assert.doesNotMatch(msg, /退出码/);
  });
});
