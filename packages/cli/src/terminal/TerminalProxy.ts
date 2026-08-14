import type { ClientChannel } from 'ssh2';
import { TextDecoder } from 'util';
import {
  TerminalMode,
  TerminalSize,
  TerminalProxyOptions,
  CTRL_O,
  CTRL_C,
  ENTER,
  BACKSPACE,
  ESC,
} from './types.js';
import { AgentUI } from './AgentUI.js';

export class TerminalProxy {
  private mode: TerminalMode = TerminalMode.DIRECT;
  private stream: ClientChannel | null = null;
  private options: TerminalProxyOptions;
  private isRawMode: boolean = false;
  private stdinListener: ((data: Buffer) => void) | null = null;
  private agentUI: AgentUI;
  private escapeSequence: Buffer = Buffer.alloc(0);
  private utf8Decoder: TextDecoder = new TextDecoder('utf-8');

  constructor(options: TerminalProxyOptions = {}) {
    this.options = options;
    this.agentUI = new AgentUI();
  }

  getTerminalSize(): TerminalSize {
    return {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    };
  }

  attach(stream: ClientChannel): void {
    this.stream = stream;
    this.setupStdin();
    this.setupStdout();
    this.setupResize();
  }

  private setupStdin(): void {
    if (!this.stream) return;

    // 启用 Raw Mode
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      this.isRawMode = true;
    }
    process.stdin.resume();

    // 监听输入
    this.stdinListener = (data: Buffer) => {
      this.handleInput(data);
    };

    process.stdin.on('data', this.stdinListener);
  }

  private handleInput(data: Buffer): void {
    if (this.mode === TerminalMode.DIRECT) {
      // 逐字节处理输入
      for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        if (byte === undefined) continue;

        // 检测 Ctrl+O 切换模式
        if (byte === CTRL_O) {
          this.toggleMode();
          continue;
        }

        // Direct 模式：透传到 SSH
        this.handleDirectModeInput(data.slice(i, i + 1));
      }
      return;
    }

    this.handleAgentModeInputBuffer(data);
  }

  private handleAgentModeInputBuffer(data: Buffer): void {
    let segmentStart = 0;
    let renderNeeded = false;

    const flushText = (end: number) => {
      if (end <= segmentStart) {
        return;
      }
      const text = this.utf8Decoder.decode(data.subarray(segmentStart, end), { stream: true });
      if (text) {
        this.agentUI.appendText(text);
        renderNeeded = true;
      }
      segmentStart = end;
    };

    const renderIfNeeded = () => {
      if (renderNeeded) {
        this.agentUI.renderAgentPrompt();
        renderNeeded = false;
      }
    };

    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      if (byte === undefined) continue;

      if (byte === CTRL_O) {
        flushText(i);
        renderIfNeeded();
        this.toggleMode();
        segmentStart = i + 1;
        continue;
      }

      if (byte === ESC) {
        flushText(i);
        renderIfNeeded();
        const consumed = this.consumeEscapeSequence(data, i);
        if (consumed > 0) {
          i += consumed - 1;
          segmentStart = i + 1;
          continue;
        }
        segmentStart = i + 1;
        continue;
      }

      if (byte === CTRL_C) {
        flushText(i);
        this.agentUI.clearInputBuffer();
        process.stdout.write('^C\n');
        this.agentUI.renderAgentPrompt();
        segmentStart = i + 1;
        continue;
      }

      if (byte === ENTER) {
        flushText(i);
        renderIfNeeded();
        const input = this.agentUI.getInputBuffer().trim();
        if (input) {
          this.agentUI.clearInputBuffer();
          this.options.onAgentInput?.(input);
        } else {
          process.stdout.write('\n');
          this.agentUI.renderAgentPrompt();
        }
        segmentStart = i + 1;
        continue;
      }

      if (byte === BACKSPACE || byte === 0x08) {
        flushText(i);
        renderIfNeeded();
        this.agentUI.deleteChar();
        this.agentUI.renderAgentPrompt();
        segmentStart = i + 1;
        continue;
      }

      if (byte === 0x01) {
        flushText(i);
        renderIfNeeded();
        this.agentUI.moveCursorToStart();
        this.agentUI.renderAgentPrompt();
        segmentStart = i + 1;
        continue;
      }

      if (byte === 0x05) {
        flushText(i);
        renderIfNeeded();
        this.agentUI.moveCursorToEnd();
        this.agentUI.renderAgentPrompt();
        segmentStart = i + 1;
        continue;
      }
    }

    flushText(data.length);
    renderIfNeeded();
  }

  private consumeEscapeSequence(data: Buffer, index: number): number {
    if (index + 1 >= data.length) {
      return 0;
    }

    if (data[index + 1] !== 0x5b) {
      return 1;
    }

    if (index + 2 >= data.length) {
      return 0;
    }

    switch (data[index + 2]) {
      case 0x41: // Up arrow
        return 3;
      case 0x42: // Down arrow
        return 3;
      case 0x43: // Right arrow
        this.agentUI.moveCursorRight();
        this.agentUI.renderAgentPrompt();
        return 3;
      case 0x44: // Left arrow
        this.agentUI.moveCursorLeft();
        this.agentUI.renderAgentPrompt();
        return 3;
      default:
        return 3;
    }
  }

  private handleDirectModeInput(data: Buffer): void {
    if (this.stream && !this.stream.destroyed) {
      this.stream.write(data);
    }
  }

  private handleAgentModeInput(byte: number, fullData: Buffer, index: number): void {
    // 处理 Escape 序列（方向键等）
    if (byte === ESC) {
      // 检查是否是 escape 序列的开始
      if (index + 2 < fullData.length) {
        const seq = fullData.slice(index, index + 3);
        if (seq[1] === 0x5b) { // '['
          // 方向键序列: ESC [ A/B/C/D
          switch (seq[2]) {
            case 0x41: // Up arrow - 暂不处理历史记录
              return;
            case 0x42: // Down arrow
              return;
            case 0x43: // Right arrow
              this.agentUI.moveCursorRight();
              this.agentUI.renderAgentPrompt();
              return;
            case 0x44: // Left arrow
              this.agentUI.moveCursorLeft();
              this.agentUI.renderAgentPrompt();
              return;
          }
        }
      }
      return;
    }

    // 处理 Ctrl+C - 清除当前输入
    if (byte === CTRL_C) {
      this.agentUI.clearInputBuffer();
      process.stdout.write('^C\n');
      this.agentUI.renderAgentPrompt();
      return;
    }

    // 处理 Enter - 提交输入
    if (byte === ENTER) {
      const input = this.agentUI.getInputBuffer().trim();
      if (input) {
        this.agentUI.clearInputBuffer();
        this.options.onAgentInput?.(input);
      } else {
        process.stdout.write('\n');
        this.agentUI.renderAgentPrompt();
      }
      return;
    }

    // 处理 Backspace
    if (byte === BACKSPACE || byte === 0x08) {
      this.agentUI.deleteChar();
      this.agentUI.renderAgentPrompt();
      return;
    }

    // 处理 Ctrl+A - 移动到行首
    if (byte === 0x01) {
      this.agentUI.moveCursorToStart();
      this.agentUI.renderAgentPrompt();
      return;
    }

    // 处理 Ctrl+E - 移动到行尾
    if (byte === 0x05) {
      this.agentUI.moveCursorToEnd();
      this.agentUI.renderAgentPrompt();
      return;
    }

    // 处理可打印字符 (ASCII 32-126)
    if (byte >= 32 && byte <= 126) {
      this.agentUI.appendChar(String.fromCharCode(byte));
      this.agentUI.renderAgentPrompt();
      return;
    }
  }

  private setupStdout(): void {
    if (!this.stream) return;

    // SSH stream 输出渲染到终端
    this.stream.on('data', (data: Buffer) => {
      // 只有在 Direct 模式下才显示 SSH 输出
      if (this.mode === TerminalMode.DIRECT) {
        process.stdout.write(data);
      }
      // 无论什么模式都记录到上下文缓冲区
      this.options.onData?.(data);
    });

    // stderr 也输出
    this.stream.stderr.on('data', (data: Buffer) => {
      if (this.mode === TerminalMode.DIRECT) {
        process.stderr.write(data);
      }
      this.options.onData?.(data);
    });
  }

  private setupResize(): void {
    // 监听终端窗口大小变化
    const handleResize = () => {
      if (this.stream) {
        const { cols, rows } = this.getTerminalSize();
        this.stream.setWindow(rows, cols, 0, 0);
      }
    };

    process.stdout.on('resize', handleResize);
  }

  getMode(): TerminalMode {
    return this.mode;
  }

  setMode(mode: TerminalMode): void {
    if (this.mode !== mode) {
      const prevMode = this.mode;
      this.mode = mode;

      // 渲染 UI 切换效果
      if (mode === TerminalMode.AGENT) {
        this.agentUI.renderEnterAgentMode();
      } else {
        this.agentUI.clearInputBuffer();
        this.agentUI.renderExitAgentMode();
      }

      this.options.onModeChange?.(mode);
    }
  }

  toggleMode(): TerminalMode {
    const newMode =
      this.mode === TerminalMode.DIRECT
        ? TerminalMode.AGENT
        : TerminalMode.DIRECT;
    this.setMode(newMode);
    return newMode;
  }

  getAgentUI(): AgentUI {
    return this.agentUI;
  }

  detach(): void {
    // 恢复终端设置
    if (this.isRawMode && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      this.isRawMode = false;
    }

    // 移除 stdin 监听器
    if (this.stdinListener) {
      process.stdin.removeListener('data', this.stdinListener);
      this.stdinListener = null;
    }

    process.stdin.pause();
    this.stream = null;
  }

  write(data: string | Buffer): boolean {
    if (this.stream && !this.stream.destroyed) {
      return this.stream.write(data);
    }
    return false;
  }
}
