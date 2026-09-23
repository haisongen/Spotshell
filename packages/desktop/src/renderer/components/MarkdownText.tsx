import { parseMarkdown, type InlineToken } from '../../shared/chatMarkdown'

function Inline({ tokens }: { tokens: InlineToken[] }): JSX.Element {
  return (
    <>
      {tokens.map((token, index) =>
        token.type === 'strong' ? <strong key={index}>{token.text}</strong>
          : token.type === 'code' ? <code key={index}>{token.text}</code>
            : token.text
      )}
    </>
  )
}

/** Renders assistant prose; see chatMarkdown for the supported subset. */
export function MarkdownText({ source }: { source: string }): JSX.Element | null {
  const blocks = parseMarkdown(source)
  if (blocks.length === 0) return null
  return (
    <div className="chat-markdown">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1]!
          return <Tag key={index}><Inline tokens={block.inline} /></Tag>
        }
        if (block.type === 'list') {
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex}><Inline tokens={item} /></li>
          ))
          return block.ordered
            ? <ol key={index} start={block.start === 1 ? undefined : block.start}>{items}</ol>
            : <ul key={index}>{items}</ul>
        }
        return <p key={index}><Inline tokens={block.inline} /></p>
      })}
    </div>
  )
}
