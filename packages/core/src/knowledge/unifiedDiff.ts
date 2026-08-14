/**
 * Line-level unified diff for Chat review (ADR-040 knowledge proposals).
 * Produces real git-style hunks (matched context + minimal add/del runs)
 * instead of a blanket "delete everything, add everything" dump.
 */

type DiffOpKind = 'equal' | 'del' | 'add';

interface DiffOp {
  kind: DiffOpKind;
  line: string;
}

const CONTEXT_LINES = 3;
// Guards the O(n*m) LCS table against pathological huge/unrelated file pairs.
const MAX_LCS_CELLS = 4_000_000;

export function buildUnifiedDiff(relativePath: string, current: string, incoming: string): string {
  if (current === incoming) {
    return `--- a/${relativePath}\n+++ b/${relativePath}\n`;
  }

  const leftLines = current.split('\n');
  const rightLines = incoming.split('\n');
  // Drop the artificial trailing empty segment created by a final newline.
  if (leftLines.length > 0 && leftLines[leftLines.length - 1] === '') leftLines.pop();
  if (rightLines.length > 0 && rightLines[rightLines.length - 1] === '') rightLines.pop();

  const ops = diffLines(leftLines, rightLines);
  const hunks = formatHunks(ops);
  const header = `--- a/${relativePath}\n+++ b/${relativePath}`;
  return hunks ? `${header}\n${hunks}\n` : `${header}\n`;
}

function diffLines(a: string[], b: string[]): DiffOp[] {
  let prefix = 0;
  const maxPrefix = Math.min(a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const midOps: DiffOp[] = midA.length * midB.length > MAX_LCS_CELLS
    ? [
      ...midA.map((line): DiffOp => ({ kind: 'del', line })),
      ...midB.map((line): DiffOp => ({ kind: 'add', line })),
    ]
    : lcsDiff(midA, midB);

  return [
    ...a.slice(0, prefix).map((line): DiffOp => ({ kind: 'equal', line })),
    ...midOps,
    ...a.slice(a.length - suffix).map((line): DiffOp => ({ kind: 'equal', line })),
  ];
}

/** Classic LCS dynamic program, backtracked into equal/del/add runs. */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const dpI = dp[i]!;
    const dpNext = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      dpI[j] = a[i] === b[j] ? dpNext[j + 1]! + 1 : Math.max(dpNext[j]!, dpI[j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', line: a[i]! });
      i++; j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'del', line: a[i]! });
      i++;
    } else {
      ops.push({ kind: 'add', line: b[j]! });
      j++;
    }
  }
  while (i < n) { ops.push({ kind: 'del', line: a[i]! }); i++; }
  while (j < m) { ops.push({ kind: 'add', line: b[j]! }); j++; }
  return ops;
}

/** Groups ops into `@@ -a,b +c,d @@` hunks with up to CONTEXT_LINES of surrounding context. */
function formatHunks(ops: DiffOp[]): string {
  if (!ops.some((op) => op.kind !== 'equal')) return '';

  const oldLineAt: number[] = [];
  const newLineAt: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    oldLineAt.push(oldLine);
    newLineAt.push(newLine);
    if (op.kind !== 'add') oldLine++;
    if (op.kind !== 'del') newLine++;
  }

  const ranges: Array<[number, number]> = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === 'equal') { index++; continue; }

    const rangeStart = Math.max(0, index - CONTEXT_LINES);
    let rangeEnd = index;
    let cursor = index;
    while (cursor < ops.length) {
      if (ops[cursor]!.kind !== 'equal') { rangeEnd = cursor + 1; cursor++; continue; }
      let equalRunEnd = cursor;
      while (equalRunEnd < ops.length && ops[equalRunEnd]!.kind === 'equal') equalRunEnd++;
      const equalRunLength = equalRunEnd - cursor;
      if (equalRunEnd >= ops.length || equalRunLength > CONTEXT_LINES * 2) {
        rangeEnd = Math.min(equalRunEnd, cursor + CONTEXT_LINES);
        cursor = equalRunEnd;
        break;
      }
      rangeEnd = equalRunEnd;
      cursor = equalRunEnd;
    }

    ranges.push([rangeStart, rangeEnd]);
    index = cursor;
  }

  const markerFor: Record<DiffOpKind, string> = { equal: ' ', del: '-', add: '+' };
  const hunks = ranges.map(([start, end]) => {
    const slice = ops.slice(start, end);
    const oldStart = oldLineAt[start]!;
    const newStart = newLineAt[start]!;
    const oldCount = slice.filter((op) => op.kind !== 'add').length;
    const newCount = slice.filter((op) => op.kind !== 'del').length;
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    const body = slice.map((op) => `${markerFor[op.kind]}${op.line}`);
    return [header, ...body].join('\n');
  });

  return hunks.join('\n');
}
