export type ChatSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string }

const FENCE = /```[^\n`]*\n([\s\S]*?)```/g

/** 把 assistant 回复按 fenced code block 切段；未闭合的 fence 一律按文本处理 */
export function splitCodeBlocks(content: string): ChatSegment[] {
  const segments: ChatSegment[] = []
  let last = 0
  FENCE.lastIndex = 0

  for (let match = FENCE.exec(content); match; match = FENCE.exec(content)) {
    if (match.index > last) {
      segments.push({ type: 'text', content: content.slice(last, match.index) })
    }
    const code = match[1]!.replace(/\n$/, '')
    if (code.trim()) {
      segments.push({ type: 'code', content: code })
    }
    last = match.index + match[0].length
  }

  if (last < content.length) {
    segments.push({ type: 'text', content: content.slice(last) })
  }
  if (segments.length === 0) {
    segments.push({ type: 'text', content })
  }
  return segments
}
