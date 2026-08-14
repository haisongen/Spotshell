export enum TerminalMode {
  DIRECT = 'direct',
  AGENT = 'agent',
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalProxyOptions {
  onModeChange?: (mode: TerminalMode) => void;
  onData?: (data: Buffer) => void;
  onAgentInput?: (input: string) => void;
}

// Ctrl+O 的字节码 (ASCII 15)
export const CTRL_O = 0x0f;
// Ctrl+C 的字节码 (ASCII 3)
export const CTRL_C = 0x03;
// Enter 键
export const ENTER = 0x0d;
// Backspace 键
export const BACKSPACE = 0x7f;
// Escape 键
export const ESC = 0x1b;
