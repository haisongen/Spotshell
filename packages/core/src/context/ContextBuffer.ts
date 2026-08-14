// 动态导入 strip-ansi (ESM 模块)
let stripAnsi: (text: string) => string;

async function loadStripAnsi(): Promise<void> {
  if (!stripAnsi) {
    const module = await import('strip-ansi');
    stripAnsi = module.default;
  }
}

// 初始化时加载
loadStripAnsi();

export interface ContextBufferOptions {
  maxSize?: number;  // 最大字符数
  maxLines?: number; // 最大行数
}

export class ContextBuffer {
  private buffer: string[] = [];
  private maxSize: number;
  private maxLines: number;
  private currentSize: number = 0;

  constructor(options: ContextBufferOptions = {}) {
    this.maxSize = options.maxSize || 50000;  // 默认 50KB
    this.maxLines = options.maxLines || 1000;  // 默认 1000 行
  }

  async append(data: Buffer | string): Promise<void> {
    // 确保 stripAnsi 已加载
    await loadStripAnsi();

    const text = typeof data === 'string' ? data : data.toString('utf-8');

    // 清除 ANSI 转义码
    const cleanText = stripAnsi ? stripAnsi(text) : text;

    // 按行分割
    const lines = cleanText.split(/\r?\n/);

    for (const line of lines) {
      if (line.length === 0) continue;

      this.buffer.push(line);
      this.currentSize += line.length;
    }

    // 维护缓冲区大小
    this.trim();
  }

  private trim(): void {
    // 按行数限制
    while (this.buffer.length > this.maxLines) {
      const removed = this.buffer.shift();
      if (removed) {
        this.currentSize -= removed.length;
      }
    }

    // 按字符数限制
    while (this.currentSize > this.maxSize && this.buffer.length > 0) {
      const removed = this.buffer.shift();
      if (removed) {
        this.currentSize -= removed.length;
      }
    }
  }

  getContext(lastNLines?: number): string {
    if (lastNLines && lastNLines < this.buffer.length) {
      return this.buffer.slice(-lastNLines).join('\n');
    }
    return this.buffer.join('\n');
  }

  getRecentContext(maxChars: number = 5000): string {
    const lines: string[] = [];
    let totalChars = 0;

    // 从后往前取，直到达到字符限制
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const line = this.buffer[i];
      if (line === undefined) continue;

      if (totalChars + line.length > maxChars) {
        break;
      }
      lines.unshift(line);
      totalChars += line.length + 1; // +1 for newline
    }

    return lines.join('\n');
  }

  /**
   * 启发式提取最后一条用户命令（Shell Integration 未激活时的回退）。
   * 提示符形态覆盖：`[user@host dir]$ cmd`、`user@host:~/dir$ cmd`、
   * `root@host:/etc# cmd`、裸 `$ cmd` / `> cmd`。
   * 前缀必须是 [..] 包裹、或含 @ 的 user@host 形态、或为空（保持旧行为兼容）。
   */
  private static readonly PROMPT_LINE =
    /^(?:\[[^\]]{1,80}\]|[^\s$#>]{1,40}@[^\s$#>]{1,80}|)[$#>]\s+(\S.*)$/;

  getLastCommand(): string | undefined {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const line = this.buffer[i];
      if (line === undefined) continue;
      // 跳过 Shell Integration 注入命令自身的回显
      if (line.includes('__spotshell_')) continue;

      const match = line.match(ContextBuffer.PROMPT_LINE);
      if (match && match[1]) {
        return match[1].trimEnd();
      }
    }
    return undefined;
  }

  getLastError(): string | undefined {
    // 尝试找到最后一个错误信息
    const errorPatterns = [
      /error:/i,
      /exception:/i,
      /failed:/i,
      /fatal:/i,
      /permission denied/i,
      /command not found/i,
      /no such file/i,
    ];

    const errorLines: string[] = [];
    let foundError = false;

    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const line = this.buffer[i];
      if (line === undefined) continue;

      if (errorPatterns.some(pattern => pattern.test(line))) {
        foundError = true;
      }

      if (foundError) {
        errorLines.unshift(line);
        // 收集错误上下文（最多 10 行）
        if (errorLines.length >= 10) break;
      }
    }

    return errorLines.length > 0 ? errorLines.join('\n') : undefined;
  }

  clear(): void {
    this.buffer = [];
    this.currentSize = 0;
  }

  getLineCount(): number {
    return this.buffer.length;
  }

  getSize(): number {
    return this.currentSize;
  }
}
