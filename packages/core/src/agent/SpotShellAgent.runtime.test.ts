import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { SpotShellAgent } from './SpotShellAgent.js';
import type { SSHExecutor } from './types.js';
import type { ModelProvider, ModelProviderId } from './providers/types.js';

class ScriptedToolChatModel extends BaseChatModel {
  readonly receivedMessages: BaseMessage[][] = [];
  private nextResponse = 0;

  constructor(private readonly responses: AIMessage[]) {
    super({});
  }

  _llmType(): string {
    return 'scripted-tool-chat-model';
  }

  bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.receivedMessages.push([...messages]);
    const message = this.responses[this.nextResponse];
    if (!message) throw new Error('No scripted model response remains');
    this.nextResponse += 1;
    return {
      generations: [{
        text: typeof message.content === 'string' ? message.content : '',
        message,
      }],
    };
  }
}

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
  const model = new FakeListChatModel({ responses: ['deterministic reply'] });
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    executor,
    undefined,
    { model }
  );

  const reply = await agent.chat('Inspect the host', { terminalHistory: '' });

  assert.equal(reply, 'deterministic reply');
  assert.deepEqual(executor.executedCommands, []);
});

test('an injected model can deterministically call an SSH tool and use its result', async () => {
  const executor = new FakeSshExecutor();
  const model = new ScriptedToolChatModel([
    new AIMessage({
      content: '',
      tool_calls: [{
        id: 'call-1',
        name: 'execute_ssh_command',
        args: { command: 'uname -a' },
        type: 'tool_call',
      }],
    }),
    new AIMessage('The deterministic host is running Linux.'),
  ]);
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    executor,
    undefined,
    { model }
  );

  const reply = await agent.chat('Inspect the host', { terminalHistory: '' });

  assert.equal(reply, 'The deterministic host is running Linux.');
  assert.deepEqual(executor.executedCommands, ['uname -a']);
  const toolResult = model.receivedMessages[1]?.find((message) =>
    ToolMessage.isInstance(message)
  );
  assert.ok(toolResult);
  assert.match(String(toolResult.content), /Linux deterministic-host 6\.8\.0/);
});

test('repairs an incomplete persisted tool batch before the next model request', async () => {
  const executor = new FakeSshExecutor();
  const model = new ScriptedToolChatModel([
    new AIMessage('Recovered from incomplete tool history.'),
  ]);
  const agent = new SpotShellAgent(
    { apiKey: 'unused' },
    executor,
    undefined,
    { model }
  );
  agent.setHistory([
    new HumanMessage('old request'),
    new AIMessage({
      content: '',
      tool_calls: [
        { id: 'old-1', name: 'execute_ssh_command', args: { command: 'uname' } },
        { id: 'old-2', name: 'execute_ssh_command', args: { command: 'uptime' } },
      ],
    }),
    new ToolMessage({ tool_call_id: 'old-1', content: 'partial result' }),
  ]);

  const reply = await agent.chat('continue', { terminalHistory: '' });

  assert.equal(reply, 'Recovered from incomplete tool history.');
  assert.equal(model.receivedMessages[0]?.some((message) => ToolMessage.isInstance(message)), false);
  assert.equal(model.receivedMessages[0]?.some((message) => (
    AIMessage.isInstance(message) && Boolean(message.tool_calls?.length)
  )), false);
});

test('updateModel switches provider on the next turn and preserves history', async () => {
  const oldModel = new FakeListChatModel({ responses: ['old reply'] });
  const newModel = new FakeListChatModel({ responses: ['new reply'] });
  const providers: Record<ModelProviderId, ModelProvider> = {
    openai: fakeProvider('openai', 'gpt-default', oldModel),
    anthropic: fakeProvider('anthropic', 'claude-default', newModel),
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
  assert.equal(agent.getHistory().filter((message) => HumanMessage.isInstance(message)).length, 2);
});

test('updateModel keeps the current model and metadata when creation fails', async () => {
  const oldModel = new FakeListChatModel({ responses: ['still old'] });
  const providers: Record<ModelProviderId, ModelProvider> = {
    openai: fakeProvider('openai', 'gpt-default', oldModel),
    anthropic: {
      ...fakeProvider('anthropic', 'claude-default', oldModel),
      createChatModel() { throw new Error('factory failed'); },
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

function fakeProvider(
  id: ModelProviderId,
  defaultModel: string,
  model: BaseChatModel,
): ModelProvider {
  return {
    id,
    defaultModel,
    createChatModel: () => model,
    normalizeError: () => ({ kind: 'unknown', message: 'provider failed' }),
  };
}
