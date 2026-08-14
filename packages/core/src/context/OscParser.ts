export type ShellIntegrationEvent =
  | { type: 'prompt'; exitCode: number; cwd: string }
  | { type: 'command'; command: string };

const OSC_PREFIX = '\u001b]6973;';
const BEL = '\u0007';
const ST = '\u001b\\';
/** 未终止序列的最大缓存长度，超限整段丢弃（防止恶意/异常输出撑爆内存） */
const MAX_PENDING = 4096;

export class OscParser {
  private pending = '';

  feed(chunk: string): ShellIntegrationEvent[] {
    let text = this.pending + chunk;
    this.pending = '';
    const events: ShellIntegrationEvent[] = [];

    for (;;) {
      const idx = text.indexOf(OSC_PREFIX);
      if (idx === -1) break;

      const start = idx + OSC_PREFIX.length;
      const bel = text.indexOf(BEL, start);
      const st = text.indexOf(ST, start);
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);

      if (end === -1) {
        // 序列未终止：整段留到下一 chunk；超限则丢弃
        const rest = text.slice(idx);
        this.pending = rest.length <= MAX_PENDING ? rest : '';
        return events;
      }

      const event = parseBody(text.slice(start, end));
      if (event) events.push(event);
      text = text.slice(end + (end === bel ? BEL.length : ST.length));
    }

    // 尾部可能是被 chunk 边界截断的前缀（如 "\u001b]69"）
    this.pending = danglingPrefix(text);
    return events;
  }
}

function parseBody(body: string): ShellIntegrationEvent | null {
  if (body.startsWith('D;')) {
    const rest = body.slice(2);
    const sep = rest.indexOf(';');
    if (sep < 0) return null;
    const exitCode = Number(rest.slice(0, sep));
    if (!Number.isInteger(exitCode)) return null;
    return { type: 'prompt', exitCode, cwd: rest.slice(sep + 1) };
  }
  if (body.startsWith('C;')) {
    return { type: 'command', command: body.slice(2) };
  }
  return null;
}

function danglingPrefix(text: string): string {
  const max = Math.min(text.length, OSC_PREFIX.length - 1);
  for (let k = max; k >= 1; k -= 1) {
    if (text.endsWith(OSC_PREFIX.slice(0, k))) return text.slice(text.length - k);
  }
  return '';
}
