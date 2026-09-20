import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotShellAgent } from './SpotShellAgent.js';
import type { SSHExecutor } from './types.js';
import type { ModelProvider, ModelProviderId } from './providers/types.js';
import { assistantMessage, isUser, toolResultMessage, userMessage } from './message.js';
import { createFauxModelProvider, loadPiAi } from '../testing/fauxModelProvider.js';

class FakeSshExecutor implements SSHExecutor {
  readonly executedCommands: string[] = [];

  async execute(command: string) {
    this.executedCommands.push(command);
    return {
      command,
      stdout: 'Linux deterministic-host 6.8.0',
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

test('an injected model can produce a deterministic reply', async () => {
  const executor = new FakeSshExecutor();
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({
    responses: [fauxAssistantMessage('deterministic reply')],
  });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    executor,
    undefined,
    { providerResolver: () => faux.provider }
  );

  const reply = await agent.chat('Inspect the host', { terminalHistory: '' });

  assert.equal(reply, 'deterministic reply');
  assert.deepEqual(executor.executedCommands, []);
});

test('an injected model can deterministically call an SSH tool and use its result', async () => {
  const executor = new FakeSshExecutor();
  const { fauxAssistantMessage, fauxToolCall } = await loadPiAi();
  const faux = await createFauxModelProvider({
    responses: [
      fauxAssistantMessage([
        fauxToolCall('execute_ssh_command', { command: 'uname -a' }, { id: 'call-1' }),
      ]),
      fauxAssistantMessage('The deterministic host is running Linux.'),
    ],
  });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    executor,
    undefined,
    { providerResolver: () => faux.provider }
  );

  const reply = await agent.chat('Inspect the host', { terminalHistory: '' });

  assert.equal(reply, 'The deterministic host is running Linux.');
  assert.deepEqual(executor.executedCommands, ['uname -a']);
  const toolResult = faux.requests[1]?.messages.find((message) => message.role === 'toolResult');
  assert.ok(toolResult);
  assert.match(JSON.stringify(toolResult.content), /Linux deterministic-host 6\.8\.0/);
  // The tool loadout really crossed into the provider request.
  assert.ok(faux.requests[0]?.toolNames.includes('execute_ssh_command'));
});

test('repairs an incomplete persisted tool batch before the next model request', async () => {
  const executor = new FakeSshExecutor();
  const { fauxAssistantMessage } = await loadPiAi();
  const faux = await createFauxModelProvider({
    responses: [fauxAssistantMessage('Recovered from incomplete tool history.')],
  });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    executor,
    undefined,
    { providerResolver: () => faux.provider }
  );
  agent.setHistory([
    userMessage('old request'),
    assistantMessage('', [
      { id: 'old-1', name: 'execute_ssh_command', arguments: { command: 'uname' } },
      { id: 'old-2', name: 'execute_ssh_command', arguments: { command: 'uptime' } },
    ]),
    toolResultMessage({ toolCallId: 'old-1', toolName: 'execute_ssh_command', text: 'partial result' }),
  ]);

  const reply = await agent.chat('continue', { terminalHistory: '' });

  assert.equal(reply, 'Recovered from incomplete tool history.');
  const firstRequest = faux.requests[0]?.messages ?? [];
  assert.equal(firstRequest.some((message) => message.role === 'toolResult'), false);
  assert.equal(
    firstRequest.some((message) => (
      message.role === 'assistant'
      && message.content.some((block) => block.type === 'toolCall')
    )),
    false,
  );
});

test('updateModel switches provider on the next turn and preserves history', async () => {
  const { fauxAssistantMessage } = await loadPiAi();
  const oldFaux = await createFauxModelProvider({
    id: 'openai',
    modelId: 'gpt-default',
    responses: [fauxAssistantMessage('old reply')],
  });
  const newFaux = await createFauxModelProvider({
    id: 'anthropic',
    modelId: 'claude-default',
    responses: [fauxAssistantMessage('new reply')],
  });
  const providers: Record<ModelProviderId, ModelProvider> = {
    openai: oldFaux.provider,
    anthropic: newFaux.provider,
  };
  const agent = new SpotShellAgent(
    { provider: 'openai', apiKey: 'old-key' },
    new FakeSshExecutor(),
    undefined,
    { providerResolver: (id) => providers[id] },
  );

  assert.equal(await agent.chat('first', { terminalHistory: '' }), 'old reply');
  agent.updateModel({ provider: 'anthropic', apiKey: 'new-key' });
  assert.equal(await agent.chat('second', { terminalHistory: '' }), 'new reply');
  assert.equal(agent.getHistory().filter(isUser).length, 2);
  // The turn after the switch really went to the other provider, carrying history.
  assert.equal(oldFaux.requests.length, 1);
  assert.equal(newFaux.requests.length, 1);
  assert.equal(newFaux.requests[0]?.messages.length, 3);
});

test('updateModel keeps the current model and metadata when model resolution fails', async () => {
  const { fauxAssistantMessage } = await loadPiAi();
  const oldFaux = await createFauxModelProvider({
    id: 'openai',
    modelId: 'gpt-default',
    responses: [fauxAssistantMessage('still old')],
  });
  const providers: Record<ModelProviderId, ModelProvider> = {
    openai: oldFaux.provider,
    anthropic: {
      ...oldFaux.provider,
      id: 'anthropic',
      defaultModel: 'claude-default',
      // Mirrors the real providers, which validate the config before awaiting.
      resolveModel() { throw new Error('factory failed'); },
    },
  };
  const agent = new SpotShellAgent(
    { provider: 'openai', apiKey: 'old-key' },
    new FakeSshExecutor(),
    undefined,
    { providerResolver: (id) => providers[id] },
  );

  assert.throws(() => agent.updateModel({ provider: 'anthropic', apiKey: 'new-key' }), /factory failed/);
  assert.equal(await agent.chat('request', { terminalHistory: '' }), 'still old');
});

test('a missing API key still fails synchronously at construction', async () => {
  const faux = await createFauxModelProvider({});
  assert.throws(
    () => new SpotShellAgent(
      { apiKey: '' },
      new FakeSshExecutor(),
      undefined,
      { providerResolver: () => faux.provider },
    ),
    /no API key configured/,
  );
});
