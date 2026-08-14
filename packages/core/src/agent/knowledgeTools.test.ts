import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe, it } from 'node:test';
import { createKnowledgeTools } from './knowledgeTools.js';
import { KnowledgeHarness } from '../knowledge/knowledgeHarness.js';
import { temporaryDirectory } from '../knowledge/temporaryDirectory.testSupport.js';

const OBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const SPACE_MD = `---
schema_version: 1
id: ${OBJECT_ID}
kind: knowledge
name: Release Diagnostics
description: Release safety guidance.
when_to_use: Use while diagnosing a failed release.
---

# Release Diagnostics

## Guidance

- Prefer read-only inspection.
`;

function createTempHarness(t: test.TestContext): KnowledgeHarness {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-tools-');
  fs.writeFileSync(path.join(rootPath, 'SPACE.md'), SPACE_MD, 'utf8');
  return new KnowledgeHarness({
    objects: [{
      id: OBJECT_ID,
      name: 'Release Diagnostics',
      kind: 'knowledge',
      revision: 1,
      contentHash: 'hash-1',
      rootPath,
      access: 'fixed',
    }],
    catalog: [{
      id: OBJECT_ID,
      name: 'Release Diagnostics',
      description: 'Release safety guidance.',
      whenToUse: 'Use while diagnosing a failed release.',
      tags: ['release'],
      scope: 'session',
    }],
  });
}

function getTool(harness: KnowledgeHarness | undefined, name: string) {
  const tools = createKnowledgeTools({ getHarness: () => harness });
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

const CANDIDATE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const CANDIDATE_SPACE = `---
schema_version: 1
id: ${CANDIDATE_ID}
kind: knowledge
name: JVM Diagnostics
description: JVM heap guidance.
when_to_use: Use for Java memory issues.
---

# JVM Diagnostics

## Guidance

- Capture heap histogram before restarting.
`;

describe('createKnowledgeTools', () => {
  it('registers the read-only knowledge tools including select', () => {
    const names = createKnowledgeTools({ getHarness: () => undefined }).map((tool) => tool.name);
    assert.deepEqual(names, [
      'list_knowledge_catalog',
      'select_knowledge_module',
      'read_knowledge_entry',
      'list_knowledge_files',
      'search_knowledge_text',
      'read_knowledge_lines',
    ]);
  });

  it('list_knowledge_catalog returns readable objects and candidate metadata', async (t) => {
    const harness = createTempHarness(t);
    const result = await getTool(harness, 'list_knowledge_catalog').invoke({});
    const parsed = JSON.parse(String(result)) as {
      readable: Array<{ id: string; revision: number }>;
      candidates: Array<{ id: string }>;
    };
    assert.equal(parsed.readable[0]?.id, OBJECT_ID);
    assert.equal(parsed.readable[0]?.revision, 1);
    assert.equal(parsed.candidates[0]?.id, OBJECT_ID);
  });

  it('read_knowledge_entry returns content with provenance and records it on the harness', async (t) => {
    const harness = createTempHarness(t);
    const result = await getTool(harness, 'read_knowledge_entry').invoke({
      objectId: OBJECT_ID,
      revision: 1,
    });
    const parsed = JSON.parse(String(result)) as {
      content: string;
      provenance: { relativePath: string; revision: number };
    };
    assert.match(parsed.content, /Prefer read-only inspection/);
    assert.equal(parsed.provenance.relativePath, 'SPACE.md');
    assert.equal(parsed.provenance.revision, 1);
    assert.equal(harness.takeProvenance().length, 1);
  });

  it('rejects missing harness and unauthorized object ids without throwing', async () => {
    const missing = await getTool(undefined, 'read_knowledge_entry').invoke({
      objectId: OBJECT_ID,
      revision: 1,
    });
    assert.match(String(missing), /No personal knowledge|知识/);

    const harness = new KnowledgeHarness({ objects: [] });
    const unauthorized = await getTool(harness, 'read_knowledge_entry').invoke({
      objectId: OBJECT_ID,
      revision: 1,
    });
    assert.match(String(unauthorized), /not authorized|not selected|失败/);
  });

  it('select_knowledge_module activates an authorized candidate and notifies the host', async (t) => {
    const rootPath = temporaryDirectory(t, 'spotshell-select-tool-');
    fs.writeFileSync(path.join(rootPath, 'SPACE.md'), CANDIDATE_SPACE, 'utf8');
    const harness = new KnowledgeHarness({
      objects: [],
      catalog: [{
        id: CANDIDATE_ID,
        name: 'JVM Diagnostics',
        description: 'JVM heap guidance.',
        whenToUse: 'Use for Java memory issues.',
        tags: ['jvm'],
        scope: 'global',
      }],
      activatable: [{
        id: CANDIDATE_ID,
        name: 'JVM Diagnostics',
        kind: 'knowledge',
        revision: 1,
        contentHash: 'hash-jvm',
        rootPath,
        access: 'dynamic',
      }],
    });
    const selected: Array<{ moduleId: string; reason: string }> = [];
    const tools = createKnowledgeTools({
      getHarness: () => harness,
      onModuleSelected: (selection) => {
        selected.push({ moduleId: selection.moduleId, reason: selection.reason });
      },
    });
    const tool = tools.find((candidate) => candidate.name === 'select_knowledge_module');
    assert.ok(tool);

    const result = await tool.invoke({
      objectId: CANDIDATE_ID,
      reason: 'User asked about heap pressure',
    });
    const parsed = JSON.parse(String(result)) as {
      selection: { moduleId: string; revision: number; loadType: string; reason: string };
      content: string;
    };
    assert.equal(parsed.selection.moduleId, CANDIDATE_ID);
    assert.equal(parsed.selection.revision, 1);
    assert.equal(parsed.selection.loadType, 'dynamic');
    assert.equal(parsed.selection.reason, 'User asked about heap pressure');
    assert.match(parsed.content, /Capture heap histogram/);
    assert.deepEqual(selected, [{
      moduleId: CANDIDATE_ID,
      reason: 'User asked about heap pressure',
    }]);
  });

  it('select_knowledge_module refuses unauthorized candidates without notifying host', async () => {
    const harness = new KnowledgeHarness({ objects: [], catalog: [], activatable: [] });
    const selected: string[] = [];
    const tools = createKnowledgeTools({
      getHarness: () => harness,
      onModuleSelected: (selection) => selected.push(selection.moduleId),
    });
    const tool = tools.find((candidate) => candidate.name === 'select_knowledge_module');
    assert.ok(tool);
    const result = await tool.invoke({
      objectId: CANDIDATE_ID,
      reason: 'should fail',
    });
    assert.match(String(result), /not an authorized candidate|失败/);
    assert.deepEqual(selected, []);
  });

  it('does not expose SSH, write, authorization, revision, or network tools', () => {
    const names = createKnowledgeTools({ getHarness: () => undefined }).map((tool) => tool.name);
    for (const forbidden of [
      'execute_ssh_command',
      'write_to_terminal',
      'publish',
      'authorize',
      'apply_revision',
      'fetch',
    ]) {
      assert.equal(names.includes(forbidden), false);
    }
  });
});
