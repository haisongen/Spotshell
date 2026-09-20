import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SpotShellAgent } from './SpotShellAgent.js';
import type { SSHExecutor } from './types.js';
import { KnowledgeHarness } from '../knowledge/knowledgeHarness.js';
import type { DynamicModuleSelection } from '../knowledge/knowledgeHarness.js';
import { temporaryDirectory } from '../knowledge/temporaryDirectory.testSupport.js';
import { buildKnowledgeAssemblyParts } from '../context/knowledgeAssembly.js';
import { createFauxModelProvider, loadPiAi } from '../testing/fauxModelProvider.js';

const RELATED_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UNRELATED_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNED_ONLY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

class FakeSshExecutor implements SSHExecutor {
  readonly executedCommands: string[] = [];

  async execute(command: string) {
    this.executedCommands.push(command);
    return {
      command,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    };
  }

  async write(): Promise<boolean> {
    return true;
  }
}

function writeModule(
  root: string,
  id: string,
  name: string,
  guidance: string,
  extraFiles: Record<string, string> = {},
): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SPACE.md'), `---
schema_version: 1
id: ${id}
kind: knowledge
name: ${name}
description: ${name} description.
when_to_use: Use for ${name.toLocaleLowerCase('en-US')}.
---

# ${name}

## Guidance

${guidance}
`, 'utf8');
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const absolute = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  }
}

test('dynamic module select, progressive read, and follow-up stay in one Agent tool loop', async (t) => {
  const base = temporaryDirectory(t, 'spotshell-agent-dynamic-');
  const relatedRoot = path.join(base, 'related');
  const unrelatedRoot = path.join(base, 'unrelated');
  writeModule(
    relatedRoot,
    RELATED_ID,
    'JVM Diagnostics',
    '- Capture heap histogram before restarting.',
    { 'references/heap.md': 'jmap -histo:live <pid>\nline two of reference body\n' },
  );
  writeModule(
    unrelatedRoot,
    UNRELATED_ID,
    'Network Diagnostics',
    '- Check interface counters first.',
  );

  let harness = new KnowledgeHarness({
    objects: [],
    catalog: [
      {
        id: RELATED_ID,
        name: 'JVM Diagnostics',
        description: 'JVM Diagnostics description.',
        whenToUse: 'Use for jvm diagnostics.',
        tags: ['jvm'],
        scope: 'global',
      },
      {
        id: UNRELATED_ID,
        name: 'Network Diagnostics',
        description: 'Network Diagnostics description.',
        whenToUse: 'Use for network diagnostics.',
        tags: ['net'],
        scope: 'global',
      },
    ],
    activatable: [
      {
        id: RELATED_ID,
        name: 'JVM Diagnostics',
        kind: 'knowledge',
        revision: 1,
        contentHash: 'hash-related',
        rootPath: relatedRoot,
        access: 'dynamic',
      },
      {
        id: UNRELATED_ID,
        name: 'Network Diagnostics',
        kind: 'knowledge',
        revision: 1,
        contentHash: 'hash-unrelated',
        rootPath: unrelatedRoot,
        access: 'dynamic',
      },
    ],
  });

  const selections: DynamicModuleSelection[] = [];
  const { fauxAssistantMessage, fauxToolCall } = await loadPiAi();
  const model = await createFauxModelProvider({
    responses: [
      fauxAssistantMessage([
        fauxToolCall('select_knowledge_module', {
          objectId: RELATED_ID,
          reason: 'User asked about Java heap pressure',
        }, { id: 'call-select' }),
      ]),
      fauxAssistantMessage('Use jmap -histo:live before restarting the JVM.'),
    ],
  });

  const agent = new SpotShellAgent(
    { apiKey: 'unused', contextWindowTokens: 16_000, recursionLimit: 20 },
    new FakeSshExecutor(),
    {
      knowledge: {
        getHarness: () => harness,
        onModuleSelected: (selection) => {
          selections.push(selection);
        },
      },
    },
    { providerResolver: () => model.provider },
  );

  const reply = await agent.chat('Java heap is high', { terminalHistory: '' });
  assert.match(reply, /jmap -histo:live/);
  assert.equal(selections.length, 1);
  assert.equal(selections[0]?.moduleId, RELATED_ID);
  assert.equal(selections[0]?.reason, 'User asked about Java heap pressure');
  assert.equal(selections[0]?.loadType, 'dynamic');
  assert.equal(selections[0]?.revision, 1);

  // Same agent tool loop: select tool result then final answer (no hidden router call).
  assert.equal(model.requests.length, 2);
  const firstTool = model.requests[1]?.messages.find((message) => message.role === 'toolResult');
  assert.ok(firstTool);
  assert.match(JSON.stringify(firstTool.content), /Capture heap histogram/);
  assert.match(JSON.stringify(firstTool.content), /loadType/);

  // Progressive body read works after select in the same harness/session.
  const body = await harness.readLines(RELATED_ID, 1, 'references/heap.md', { startLine: 1 });
  assert.match(body.content, /jmap -histo:live/);
  assert.equal(body.provenance.loadReason, 'line-read');

  // Unrelated module was never selected or made readable.
  assert.equal(
    harness.listSessionOverview().readable.some((entry) => entry.id === UNRELATED_ID),
    false,
  );
  assert.ok(harness.listSessionOverview().readable.some((entry) => entry.id === RELATED_ID));

  // Follow-up: guidance from the still-active module is assembled; large body is not permanent.
  const parts = await buildKnowledgeAssemblyParts(harness);
  const followModel = await createFauxModelProvider({
    responses: [fauxAssistantMessage('Continue with the same heap histogram steps.')],
  });
  const followAgent = new SpotShellAgent(
    { apiKey: 'unused', contextWindowTokens: 16_000 },
    new FakeSshExecutor(),
    { knowledge: { getHarness: () => harness } },
    { providerResolver: () => followModel.provider },
  );
  followAgent.setKnowledgeContext(parts);
  const followReply = await followAgent.chat('what next?', { terminalHistory: '' });
  assert.match(followReply, /heap histogram/);
  // Knowledge context now rides on `Context.systemPrompt` rather than a
  // transcript message, so both halves of the request have to be inspected.
  const followRequest = followModel.requests[0];
  assert.ok(followRequest, 'the follow-up turn must have reached the provider');
  const followPrompt = [followRequest.systemPrompt, followModel.requestText(0)].join('\n');
  assert.match(followPrompt, /Capture heap histogram/);
  assert.doesNotMatch(followPrompt, /line two of reference body/);
});

test('select_knowledge_module refuses owned-but-unauthorized modules in the agent loop', async (t) => {
  const base = temporaryDirectory(t, 'spotshell-agent-unauth-');
  const ownedRoot = path.join(base, 'owned');
  writeModule(ownedRoot, OWNED_ONLY_ID, 'Secret Ops', '- Do not expose.');

  const harness = new KnowledgeHarness({
    objects: [],
    catalog: [],
    activatable: [],
  });
  const selections: string[] = [];
  const { fauxAssistantMessage, fauxToolCall } = await loadPiAi();
  const model = await createFauxModelProvider({
    responses: [
      fauxAssistantMessage([
        fauxToolCall('select_knowledge_module', {
          objectId: OWNED_ONLY_ID,
          reason: 'try owned only',
        }, { id: 'call-bad' }),
      ]),
      fauxAssistantMessage('Could not load unauthorized knowledge.'),
    ],
  });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    new FakeSshExecutor(),
    {
      knowledge: {
        getHarness: () => harness,
        onModuleSelected: (selection) => selections.push(selection.moduleId),
      },
    },
    { providerResolver: () => model.provider },
  );

  const reply = await agent.chat('load secret ops', { terminalHistory: '' });
  assert.match(reply, /Could not load unauthorized knowledge/);
  assert.deepEqual(selections, []);
  const toolResult = model.requests[1]?.messages.find((message) => message.role === 'toolResult');
  assert.ok(toolResult);
  assert.match(JSON.stringify(toolResult.content), /not an authorized candidate|失败/);
});
