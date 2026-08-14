/**
 * Keep late Agent events inside their original visible transcript segment.
 * Events after a newer context boundary must not open bubbles in the new epoch.
 */

export interface EpochTaggedItem {
  contextEpoch?: number
  kind?: string
}

/** Index of the last item that belongs to `epoch` (or untagged legacy items before a newer boundary). */
export function lastIndexForEpoch<T extends EpochTaggedItem>(items: readonly T[], epoch: number): number {
  let last = -1
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!
    const itemEpoch = item.contextEpoch
    if (itemEpoch === undefined || itemEpoch === epoch) {
      last = i
      continue
    }
    if (itemEpoch > epoch) break
    last = i
  }
  return last
}

/** Insert `item` after the last message of its epoch (before any newer-epoch content). */
export function insertForEpoch<T extends EpochTaggedItem>(items: readonly T[], item: T & { contextEpoch: number }): T[] {
  const at = lastIndexForEpoch(items, item.contextEpoch)
  if (at < 0) return [item, ...items]
  return [...items.slice(0, at + 1), item, ...items.slice(at + 1)]
}

/** Find the latest streaming assistant bubble for a given epoch. */
export function findStreamingAssistantIndex<T extends EpochTaggedItem & {
  role?: string
  streaming?: boolean
}>(items: readonly T[], epoch: number): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!
    if (item.role !== 'assistant' || !item.streaming) continue
    const itemEpoch = item.contextEpoch
    if (itemEpoch === undefined || itemEpoch === epoch) return i
    if (itemEpoch < epoch) break
  }
  return -1
}

/**
 * Close the open streaming assistant bubble of `epoch`.
 * A turn can produce several rounds of assistant text separated by tool calls;
 * sealing before a tool card is inserted makes the next round open its own
 * bubble below the card instead of being appended above it.
 */
export function sealStreamingAssistant<T extends EpochTaggedItem & {
  role?: string
  streaming?: boolean
}>(items: readonly T[], epoch: number): T[] {
  const at = findStreamingAssistantIndex(items, epoch)
  if (at < 0) return items.slice()
  const copy = items.slice()
  copy[at] = { ...copy[at]!, streaming: false }
  return copy
}

/** Find the latest pending tool bubble for a given epoch. */
export function findPendingToolIndex<T extends EpochTaggedItem & {
  role?: string
  pendingTool?: boolean
}>(items: readonly T[], epoch: number): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!
    if (item.role !== 'tool' || !item.pendingTool) continue
    const itemEpoch = item.contextEpoch
    if (itemEpoch === undefined || itemEpoch === epoch) return i
    if (itemEpoch < epoch) break
  }
  return -1
}
