import path from 'node:path';
import { parseCommandLine } from './commandParse.js';
import type { RiskLevel } from './types.js';

type Classifier = (args: string[]) => RiskLevel;

const READONLY_COMMANDS: Record<string, Classifier> = Object.fromEntries(
  [
    'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'zcat',
    'wc', 'sort', 'uniq', 'cut', 'awk', 'df', 'du', 'free', 'ps', 'top', 'uptime',
    'uname', 'whoami', 'id', 'date', 'hostname', 'pwd', 'echo', 'printf', 'env',
    'which', 'stat', 'file', 'netstat', 'ss', 'ip', 'ifconfig', 'ping', 'traceroute',
    'dig', 'nslookup', 'journalctl', 'dmesg', 'lsof', 'lsblk', 'mount', 'w', 'last',
    'history',
  ].map((name) => [name, () => 'readonly' as const])
);

const CONDITIONAL_COMMANDS: Record<string, Classifier> = {
  sed: (args) => args.some((arg) => arg === '-i' || arg.startsWith('-i')) ? 'write' : 'readonly',
  find: (args) => args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir')
    ? 'destructive'
    : 'readonly',
  systemctl: (args) => /^(status|show|list-|is-)/.test(args[0] ?? '') ? 'readonly' : 'write',
  docker: (args) => ['ps', 'images', 'logs', 'inspect', 'stats', 'version', 'info'].includes(args[0] ?? '')
    ? 'readonly'
    : 'write',
  kubectl: (args) => ['get', 'describe', 'logs', 'top', 'version'].includes(args[0] ?? '')
    ? 'readonly'
    : 'write',
  openssl: (args) => ['x509', 's_client', 'verify', 'crl', 'dgst'].includes(args[0] ?? '')
    ? 'readonly'
    : 'write',
  hdfs: (args) => classifyHadoop(args, 'dfs'),
  hadoop: (args) => classifyHadoop(args, 'fs'),
  yarn: (args) => args[0] === 'application' && args.some((arg) => arg === '-list' || arg === '-status')
    ? 'readonly'
    : 'write',
};

function classifyHadoop(args: string[], family: string): RiskLevel {
  const queries = new Set(['-ls', '-cat', '-du', '-df', '-count', '-stat', '-tail', '-text']);
  return args[0] === family && queries.has(args[1] ?? '') ? 'readonly' : 'write';
}

function commandName(value: string): string {
  return path.posix.basename(value.replace(/\\/g, '/')).toLowerCase();
}

function unwrap(argv: string[]): { command: string; args: string[]; escalated: boolean } {
  let index = 0;
  let escalated = false;

  while (index < argv.length) {
    const name = commandName(argv[index]!);
    if (name === 'sudo' || name === 'doas') {
      escalated = true;
      index += 1;
      while (argv[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (name === 'env') {
      index += 1;
      while (argv[index] && (argv[index]!.startsWith('-') || argv[index]!.includes('='))) index += 1;
      continue;
    }
    if (name === 'nice' || name === 'nohup') {
      index += 1;
      while (argv[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (name === 'timeout') {
      index += 1;
      while (argv[index]?.startsWith('-')) index += 1;
      if (argv[index]) index += 1;
      continue;
    }
    break;
  }

  return {
    command: index < argv.length ? commandName(argv[index]!) : '',
    args: argv.slice(index + 1),
    escalated,
  };
}

function hasFlag(args: string[], short: string, long?: string): boolean {
  return args.some((arg) => arg === long || (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(short)));
}

function destructiveRisk(command: string, args: string[]): RiskLevel | null {
  if (command === 'rm' && (hasFlag(args, 'r', '--recursive') || hasFlag(args, 'f', '--force'))) return 'destructive';
  if (command.startsWith('mkfs')) return 'destructive';
  if (command === 'dd' && args.some((arg) => arg.startsWith('of='))) return 'destructive';
  if (['shutdown', 'reboot', 'halt', 'poweroff', 'init', 'truncate'].includes(command)) return 'destructive';
  if (['kill', 'pkill', 'killall'].includes(command)
    && args.some((arg) => arg === '-9' || arg.toUpperCase() === '-KILL')) return 'destructive';
  if (['chmod', 'chown'].includes(command) && hasFlag(args, 'R', '--recursive')) return 'destructive';
  if (['bash', 'sh', 'zsh'].includes(command) && args.includes('-c')) return 'destructive';
  return null;
}

function classifySegment(argv: string[]): { risk: RiskLevel; command: string } {
  const { command, args, escalated } = unwrap(argv);
  if (!command) return { risk: escalated ? 'write' : 'readonly', command };

  let risk = destructiveRisk(command, args)
    ?? CONDITIONAL_COMMANDS[command]?.(args)
    ?? READONLY_COMMANDS[command]?.(args)
    ?? 'write';
  if (escalated && risk === 'readonly') risk = 'write';
  return { risk, command };
}

const RISK_ORDER: Record<RiskLevel, number> = { readonly: 0, write: 1, destructive: 2 };

function maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return RISK_ORDER[left] >= RISK_ORDER[right] ? left : right;
}

export function classifyCommand(raw: string): RiskLevel {
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(raw)) return 'destructive';

  const parsed = parseCommandLine(raw);
  if (parsed.opaque) return 'destructive';
  if (parsed.segments.length === 0) return 'readonly';

  const classified = parsed.segments.map((segment) => classifySegment(segment.argv));
  const downloaders = new Set(['curl', 'wget']);
  const interpreters = new Set(['bash', 'sh', 'zsh', 'python', 'python3', 'node', 'perl', 'ruby']);
  if (classified.some((item, index) => downloaders.has(item.command)
    && classified.slice(index + 1).some((next) => interpreters.has(next.command)))) {
    return 'destructive';
  }

  let risk = classified.reduce<RiskLevel>((current, item) => maxRisk(current, item.risk), 'readonly');
  if (parsed.hasRedirect) risk = maxRisk(risk, 'write');
  return risk;
}
