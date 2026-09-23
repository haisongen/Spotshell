/**
 * Minimal Markdown for assistant prose (fenced code is split out earlier by
 * chatSegments). Produces plain data — the renderer turns it into React
 * elements, so model output can never inject HTML.
 *
 * Supported: `#` headings, `-`/`*`/`+` and `1.` lists, paragraphs, `**bold**`
 * and `inline code`. Single `*`/`_` emphasis is deliberately left alone: it
 * collides with shell globs and snake_case far more often than it helps.
 */

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'code'; text: string }

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; inline: InlineToken[] }
  | { type: 'paragraph'; inline: InlineToken[] }
  | { type: 'list'; ordered: boolean; start: number; items: InlineToken[][] }

const INLINE = /`([^`\n]+)`|\*\*(?=\S)([^*\n]*?\S)\*\*/g
const HEADING = /^(#{1,6})\s+(.*)$/
const UNORDERED = /^\s{0,3}[-*+]\s+(.*)$/
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let last = 0
  INLINE.lastIndex = 0
  for (let match = INLINE.exec(text); match; match = INLINE.exec(text)) {
    if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) })
    if (match[1] !== undefined) tokens.push({ type: 'code', text: match[1] })
    else tokens.push({ type: 'strong', text: match[2]! })
    last = match.index + match[0].length
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) })
  return tokens
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; start: number; items: string[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) })
    paragraph = []
  }
  const flushList = (): void => {
    if (!list) return
    blocks.push({
      type: 'list',
      ordered: list.ordered,
      start: list.start,
      items: list.items.map(parseInline),
    })
    list = null
  }

  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3
      blocks.push({ type: 'heading', level, inline: parseInline(heading[2]!.trim()) })
      continue
    }

    const unordered = UNORDERED.exec(line)
    const ordered = unordered ? null : ORDERED.exec(line)
    if (unordered || ordered) {
      flushParagraph()
      const isOrdered = Boolean(ordered)
      if (list && list.ordered !== isOrdered) flushList()
      if (!list) {
        list = { ordered: isOrdered, start: ordered ? Number(ordered[1]) : 1, items: [] }
      }
      list.items.push(unordered ? unordered[1]! : ordered![2]!)
      continue
    }

    if (list) {
      // A non-marker line right after an item continues that item.
      list.items[list.items.length - 1] += `\n${line.trim()}`
      continue
    }
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  return blocks
}
