#!/usr/bin/env node

import 'dotenv/config';
import { program } from 'commander';
import inquirer from 'inquirer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ClientChannel } from 'ssh2';
import {
  SSHClient,
  ContextBuffer,
  SpotShellAgent,
  SSHCommandExecutor,
  logger,
  LogLevel,
  type SSHConnectionConfig,
} from '@spotshell/core';
import { TerminalProxy } from './terminal/TerminalProxy.js';
import { TerminalMode } from './terminal/types.js';
import { parseModelProviderEnv, type CliModelConfig } from './modelProviderEnv.js';

interface ConnectionOptions {
  port: number;
  identity?: string;
  password?: boolean;
  verbose?: boolean;
}

// 全局状态
let contextBuffer: ContextBuffer;
let agent: SpotShellAgent | null = null;
let sshExecutor: SSHCommandExecutor | null = null;

async function promptForPassword(username: string, host: string): Promise<string> {
  const answers = await inquirer.prompt<{ password: string }>([
    {
      type: 'password',
      name: 'password',
      message: `${username}@${host}'s password:`,
      mask: '*',
    },
  ]);
  return answers.password;
}

function parseTarget(target: string): { username: string; host: string } {
  const parts = target.split('@');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { username: parts[0], host: parts[1] };
  }
  return { username: os.userInfo().username, host: target };
}

function loadPrivateKey(keyPath: string): Buffer | undefined {
  const expandedPath = keyPath.replace(/^~/, os.homedir());
  try {
    return fs.readFileSync(expandedPath);
  } catch (err) {
    logger.warn(`Cannot read private key: ${expandedPath}`);
    return undefined;
  }
}

function findDefaultPrivateKey(): Buffer | undefined {
  const defaultKeys = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];
  const sshDir = path.join(os.homedir(), '.ssh');

  for (const keyName of defaultKeys) {
    const keyPath = path.join(sshDir, keyName);
    if (fs.existsSync(keyPath)) {
      try {
        return fs.readFileSync(keyPath);
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

async function handleAgentInput(input: string, terminalProxy: TerminalProxy): Promise<void> {
  const agentUI = terminalProxy.getAgentUI();

  // 处理内置命令
  if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
    terminalProxy.setMode(TerminalMode.DIRECT);
    return;
  }

  if (input.toLowerCase() === 'help') {
    const helpText = `
Available commands:
  help     - Show this help message
  clear    - Clear AI conversation history
  context  - Show current terminal context info
  exit     - Exit Agent Mode and return to Direct Mode
  quit     - Same as exit

In Agent Mode, you can ask AI questions about:
  - Error messages you've seen
  - How to use commands
  - Debugging help
  - System administration tasks

The AI can also execute commands on the remote server for you.

Press Ctrl+O at any time to toggle between modes.
`;
    agentUI.renderAgentResponse(helpText);
    return;
  }

  if (input.toLowerCase() === 'clear') {
    if (agent) {
      agent.clearHistory();
    }
    agentUI.renderAgentResponse('对话历史已清除。');
    return;
  }

  if (input.toLowerCase() === 'context') {
    const info = `
终端上下文信息:
  - 缓冲区行数: ${contextBuffer.getLineCount()}
  - 缓冲区大小: ${contextBuffer.getSize()} 字符
  - 最后命令: ${contextBuffer.getLastCommand() || '(无)'}
  - 最近错误: ${contextBuffer.getLastError() ? '已检测到' : '(无)'}
`;
    agentUI.renderAgentResponse(info);
    return;
  }

  // 检查 Agent 是否可用
  if (!agent) {
    agentUI.renderError('AI Agent 未初始化。请为当前模型 Provider 配置 API Key。');
    return;
  }

  // 显示思考状态
  agentUI.renderAgentThinking();

  try {
    // 构建上下文
    const agentContext = {
      terminalHistory: contextBuffer.getRecentContext(4000),
      lastCommand: contextBuffer.getLastCommand(),
      lastError: contextBuffer.getLastError(),
    };

    // 调用 AI
    const response = await agent.chat(input, agentContext);
    agentUI.renderAgentResponse(response);
  } catch (error) {
    agentUI.renderError(`AI 错误: ${(error as Error).message}`);
  }
}

function initializeAgent(
  client: SSHClient,
  stream: ClientChannel,
  modelConfig: CliModelConfig,
): void {
  // 初始化 SSH 命令执行器
  sshExecutor = new SSHCommandExecutor(client, stream);

  // 初始化 AI Agent
  const recursionLimitRaw = process.env['SPOTSHELL_RECURSION_LIMIT'];
  const recursionLimit = recursionLimitRaw ? Number.parseInt(recursionLimitRaw, 10) : undefined;

  if (modelConfig.apiKey) {
    agent = new SpotShellAgent(
      {
        ...modelConfig,
        temperature: 0.1,
        recursionLimit: Number.isFinite(recursionLimit) ? recursionLimit : undefined,
      },
      sshExecutor
    );
    logger.debug('AI Agent initialized');
  } else {
    logger.warn(`${modelConfig.provider} API key not set, AI features disabled`);
  }
}

async function connect(
  target: string,
  options: ConnectionOptions,
  modelConfig: CliModelConfig,
): Promise<void> {
  const { username, host } = parseTarget(target);
  const port = options.port;

  if (options.verbose) {
    logger.setLevel(LogLevel.DEBUG);
  } else {
    logger.setLevel(LogLevel.SILENT);
  }

  logger.debug(`Connecting to ${username}@${host}:${port}`);

  // 初始化上下文缓冲区
  contextBuffer = new ContextBuffer({
    maxSize: 50000,
    maxLines: 1000,
  });

  // 构建连接配置
  const config: SSHConnectionConfig = {
    host,
    port,
    username,
  };

  // 尝试加载私钥
  if (!options.password) {
    if (options.identity) {
      config.privateKey = loadPrivateKey(options.identity);
    } else {
      config.privateKey = findDefaultPrivateKey();
    }
  }

  const sshClient = new SSHClient();
  const terminalProxy = new TerminalProxy({
    onData: async (data) => {
      // 将数据写入上下文缓冲区
      await contextBuffer.append(data);
      logger.debug(`Buffered ${data.length} bytes, total lines: ${contextBuffer.getLineCount()}`);
    },
    onModeChange: (mode) => {
      logger.debug(`Mode changed to: ${mode}`);
      if (mode === TerminalMode.AGENT && agent) {
        // 进入 Agent 模式时可以做一些初始化
      }
    },
    onAgentInput: (input) => {
      // 处理 Agent 模式的用户输入
      handleAgentInput(input, terminalProxy);
    },
  });

  // 处理连接错误
  sshClient.on('error', (err: Error) => {
    console.error(`\nConnection error: ${err.message}`);
    process.exit(1);
  });

  // 处理连接关闭
  sshClient.on('close', () => {
    terminalProxy.detach();
    console.log('\nConnection closed.');
    process.exit(0);
  });

  // 如果指定了 --password 选项，直接提示输入密码
  if (options.password) {
    config.password = await promptForPassword(username, host);
  }

  try {
    await sshClient.connect(config);
  } catch (err) {
    if (!config.password) {
      try {
        config.password = await promptForPassword(username, host);
        config.privateKey = undefined;
        await sshClient.connect(config);
      } catch (authErr) {
        console.error(`\nAuthentication failed: ${(authErr as Error).message}`);
        process.exit(1);
      }
    } else {
      console.error(`\nConnection failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  logger.debug('SSH connection established');

  // 获取终端尺寸并请求 shell
  const { cols, rows } = terminalProxy.getTerminalSize();
  const stream = await sshClient.requestShell(cols, rows);

  logger.debug(`Shell started with size ${cols}x${rows}`);

  // 初始化 AI Agent
  initializeAgent(sshClient, stream, modelConfig);

  // 显示欢迎信息
  const welcomeMsg = agent
    ? '\x1b[36m[SpotShell] AI 助手已就绪，按 Ctrl+O 进入智能模式\x1b[0m\n'
    : `\x1b[33m[SpotShell] 警告: 未配置 ${modelConfig.provider} API Key，AI 功能不可用\x1b[0m\n`;
  process.stdout.write(welcomeMsg);

  // 附加终端代理
  terminalProxy.attach(stream);

  // 处理信号
  process.on('SIGINT', () => {
    terminalProxy.detach();
    sshClient.disconnect();
    process.exit(0);
  });

  // 等待 shell 关闭
  stream.on('close', () => {
    terminalProxy.detach();
    sshClient.disconnect();
  });
}

// 设置 CLI
program
  .name('spotshell')
  .description('AI-enhanced SSH client')
  .version('1.0.0')
  .argument('<target>', 'SSH target (e.g., user@hostname)')
  .option('-p, --port <port>', 'SSH port', '22')
  .option('-i, --identity <file>', 'Private key file path')
  .option('-P, --password', 'Force password authentication')
  .option('-v, --verbose', 'Enable verbose output')
  .action(async (target: string, opts: { port: string; identity?: string; password?: boolean; verbose?: boolean }) => {
    let modelConfig: CliModelConfig;
    try {
      modelConfig = parseModelProviderEnv(process.env);
    } catch (error) {
      console.error(`Configuration error: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const options: ConnectionOptions = {
      port: parseInt(opts.port, 10),
      identity: opts.identity,
      password: opts.password,
      verbose: opts.verbose,
    };
    await connect(target, options, modelConfig);
  });

program.parse();
