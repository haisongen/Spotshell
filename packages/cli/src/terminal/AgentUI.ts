import { TerminalMode } from './types.js';

// ANSI 颜色码
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // 前景色
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // 背景色
  bgCyan: '\x1b[46m',
  bgMagenta: '\x1b[45m',
  bgBlack: '\x1b[40m',
};

export class AgentUI {
  private inputBuffer: string = '';
  private cursorPos: number = 0;
  private promptLine: number = 0;

  getInputBuffer(): string {
    return this.inputBuffer;
  }

  clearInputBuffer(): void {
    this.inputBuffer = '';
    this.cursorPos = 0;
  }

  appendChar(char: string): void {
    // 在光标位置插入字符
    this.inputBuffer =
      this.inputBuffer.slice(0, this.cursorPos) +
      char +
      this.inputBuffer.slice(this.cursorPos);
    this.cursorPos++;
  }

  appendText(text: string): void {
    if (!text) {
      return;
    }
    this.inputBuffer =
      this.inputBuffer.slice(0, this.cursorPos) +
      text +
      this.inputBuffer.slice(this.cursorPos);
    this.cursorPos += text.length;
  }

  deleteChar(): void {
    if (this.cursorPos > 0) {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.cursorPos - 1) +
        this.inputBuffer.slice(this.cursorPos);
      this.cursorPos--;
    }
  }

  moveCursorLeft(): void {
    if (this.cursorPos > 0) {
      this.cursorPos--;
    }
  }

  moveCursorRight(): void {
    if (this.cursorPos < this.inputBuffer.length) {
      this.cursorPos++;
    }
  }

  moveCursorToStart(): void {
    this.cursorPos = 0;
  }

  moveCursorToEnd(): void {
    this.cursorPos = this.inputBuffer.length;
  }

  renderModeIndicator(mode: TerminalMode): void {
    const { cols } = this.getTerminalSize();

    // 保存光标位置
    process.stdout.write('\x1b[s');

    // 移动到屏幕右上角
    process.stdout.write('\x1b[1;1H');

    if (mode === TerminalMode.AGENT) {
      const indicator = ' 🤖 AGENT MODE (Ctrl+O to exit) ';
      const padding = ' '.repeat(Math.max(0, cols - indicator.length));
      process.stdout.write(
        `${COLORS.bgMagenta}${COLORS.white}${COLORS.bold}${indicator}${padding}${COLORS.reset}`
      );
    } else {
      // Direct 模式时清除指示器
      process.stdout.write(' '.repeat(cols));
    }

    // 恢复光标位置
    process.stdout.write('\x1b[u');
  }

  renderAgentPrompt(): void {
    const prompt = `${COLORS.magenta}${COLORS.bold}AI > ${COLORS.reset}`;

    // 清除当前行并显示提示符
    process.stdout.write('\r\x1b[K');
    process.stdout.write(prompt);
    process.stdout.write(this.inputBuffer);

    // 将光标移动到正确位置
    const promptLength = 5; // "AI > " 的实际长度
    const cursorPosition = promptLength + this.getDisplayWidth(this.inputBuffer.slice(0, this.cursorPos));
    process.stdout.write(`\r\x1b[${cursorPosition + 1}G`);
  }

  renderEnterAgentMode(): void {
    process.stdout.write('\n');
    process.stdout.write(
      `${COLORS.cyan}${COLORS.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}\n`
    );
    process.stdout.write(
      `${COLORS.magenta}${COLORS.bold}  🤖 Agent Mode Activated${COLORS.reset}\n`
    );
    process.stdout.write(
      `${COLORS.gray}  Type your question or command. Press Ctrl+O to exit.${COLORS.reset}\n`
    );
    process.stdout.write(
      `${COLORS.cyan}${COLORS.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}\n`
    );
    process.stdout.write('\n');
    this.renderAgentPrompt();
  }

  renderExitAgentMode(): void {
    process.stdout.write('\n');
    process.stdout.write(
      `${COLORS.cyan}${COLORS.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}\n`
    );
    process.stdout.write(
      `${COLORS.green}${COLORS.bold}  ✓ Returned to Direct Mode${COLORS.reset}\n`
    );
    process.stdout.write(
      `${COLORS.cyan}${COLORS.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}\n`
    );
    process.stdout.write('\n');
  }

  renderAgentThinking(): void {
    process.stdout.write('\n');
    process.stdout.write(
      `${COLORS.yellow}${COLORS.dim}  ⏳ AI is thinking...${COLORS.reset}\n`
    );
  }

  renderAgentResponse(response: string): void {
    process.stdout.write('\n');
    process.stdout.write(
      `${COLORS.green}${COLORS.bold}AI:${COLORS.reset} `
    );
    process.stdout.write(response);
    process.stdout.write('\n\n');
    this.renderAgentPrompt();
  }

  renderError(message: string): void {
    process.stdout.write('\n');
    process.stdout.write(
      `${COLORS.yellow}${COLORS.bold}Error:${COLORS.reset} ${message}\n`
    );
    process.stdout.write('\n');
    this.renderAgentPrompt();
  }

  private getTerminalSize(): { cols: number; rows: number } {
    return {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    };
  }

  private getDisplayWidth(text: string): number {
    let width = 0;
    for (const char of text) {
      width += this.getCharWidth(char);
    }
    return width;
  }

  private getCharWidth(char: string): number {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      return 0;
    }

    // Control characters
    if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      return 0;
    }

    // Combining marks
    if (
      (codePoint >= 0x0300 && codePoint <= 0x036f) ||
      (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
      (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    ) {
      return 0;
    }

    // Wide characters (CJK/Emoji/Fullwidth)
    if (
      (codePoint >= 0x1100 && codePoint <= 0x115f) ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    ) {
      return 2;
    }

    return 1;
  }
}
