import { StringDecoder } from 'node:string_decoder';
import { OscParser } from './OscParser.js';

/**
 * 注入到用户 PTY 的 bash 片段（一整行，行首空格配合 HISTCONTROL=ignorespace 时可避免进历史）。
 * - PROMPT_COMMAND：每次出提示符时发射 D 标记（上一条命令退出码 + $PWD）。
 * - DEBUG trap：每个提示符周期只发射一次 C 标记（即将执行的命令）。
 *   已知局限：管线只捕获第一个简单命令；非 bash shell 下整段为 no-op。
 */
export const SHELL_INTEGRATION_SNIPPET =
  ' [ -n "$BASH_VERSION" ] && { ' +
  '__spotshell_prompt() { local __ss_ec=$?; ' +
  'printf "\\033]6973;D;%s;%s\\007" "$__ss_ec" "$PWD"; __spotshell_ran=0; }; ' +
  '__spotshell_pre() { [ "${__spotshell_ran:-1}" = 1 ] && return 0; ' +
  'case "$BASH_COMMAND" in __spotshell_*) return 0;; esac; ' +
  '__spotshell_ran=1; printf "\\033]6973;C;%s\\007" "$BASH_COMMAND"; }; ' +
  "PROMPT_COMMAND=__spotshell_prompt; trap '__spotshell_pre' DEBUG; " +
  '}\n';

export class ShellIntegration {
  private parser = new OscParser();
  private decoder = new StringDecoder('utf8');
  private promptSeen = false;
  private currentCwd: string | undefined;
  private exitCode: number | undefined;
  private command: string | undefined;
  private running = false;

  feed(data: Buffer | string): void {
    const text = typeof data === 'string' ? data : this.decoder.write(data);
    for (const event of this.parser.feed(text)) {
      if (event.type === 'prompt') {
        this.promptSeen = true;
        this.currentCwd = event.cwd;
        this.exitCode = event.exitCode;
        this.running = false;
      } else {
        this.command = event.command;
        this.running = true;
      }
    }
  }

  /** 首个提示符标记到达后为 true —— 表示注入生效，可信赖标记数据 */
  get active(): boolean {
    return this.promptSeen;
  }

  get cwd(): string | undefined {
    return this.currentCwd;
  }

  get lastExitCode(): number | undefined {
    return this.exitCode;
  }

  get lastCommand(): string | undefined {
    return this.command;
  }

  get commandRunning(): boolean {
    return this.running;
  }

  /**
   * Clear last-command markers injected into a new Agent context epoch.
   * Keeps shell integration liveness and cwd; does not touch terminal display.
   */
  resetAgentEphemeralContext(): void {
    this.exitCode = undefined;
    this.command = undefined;
    this.running = false;
  }
}
