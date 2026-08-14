import { parse } from 'shell-quote';

export interface CommandSegment {
  /** Arguments for one simple command after shell-quote parsing. */
  argv: string[];
}

export interface ParsedCommandLine {
  raw: string;
  segments: CommandSegment[];
  hasRedirect: boolean;
  /** Callers must treat opaque input as highest risk. */
  opaque: boolean;
}

const SEGMENT_OPERATORS = new Set(['|', '&&', '||', ';', '&']);
const REDIRECT_OPERATORS = new Set(['>', '>>', '<', '<<', '>&', '<&']);

function hasUnclosedQuote(raw: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? null : quote ?? char;
    }
  }
  return quote !== null;
}

export function parseCommandLine(raw: string): ParsedCommandLine {
  const empty: ParsedCommandLine = { raw, segments: [], hasRedirect: false, opaque: false };
  if (!raw.trim()) return empty;
  if (raw.includes('`') || raw.includes('$(') || hasUnclosedQuote(raw)) {
    return { ...empty, opaque: true };
  }

  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(raw);
  } catch {
    return { ...empty, opaque: true };
  }

  const segments: CommandSegment[] = [];
  let argv: string[] = [];
  let hasRedirect = false;

  const finishSegment = (): void => {
    if (argv.length > 0) segments.push({ argv });
    argv = [];
  };

  for (const token of tokens) {
    if (typeof token === 'string') {
      argv.push(token);
      continue;
    }
    if (!('op' in token) || typeof token.op !== 'string') {
      return { raw, segments, hasRedirect, opaque: true };
    }
    if (SEGMENT_OPERATORS.has(token.op)) {
      finishSegment();
      continue;
    }
    if (REDIRECT_OPERATORS.has(token.op)) {
      hasRedirect = true;
      continue;
    }
    return { raw, segments, hasRedirect, opaque: true };
  }

  finishSegment();
  return { raw, segments, hasRedirect, opaque: false };
}
