/** Shape shared by knowledge module and environment list rows the search box filters. */
export interface KnowledgeFilterable {
  name: string
  description?: string
  tags?: readonly string[]
  /** ISO timestamp of the last draft save; drives the "recently edited" order. */
  draftSavedAt?: string
}

export type KnowledgeSortMode = 'name' | 'recent'

export const KNOWLEDGE_SORT_MODES: readonly KnowledgeSortMode[] = ['name', 'recent']

export function isKnowledgeSortMode(value: unknown): value is KnowledgeSortMode {
  return value === 'name' || value === 'recent'
}

/** Lowercase search terms; blank input yields none, and no terms matches everything. */
export function parseKnowledgeQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Every term must appear in the name, description or one tag (AND across terms). */
export function matchesKnowledgeQuery(
  item: KnowledgeFilterable,
  terms: readonly string[]
): boolean {
  if (terms.length === 0) return true
  const haystack = [item.name, item.description ?? '', ...(item.tags ?? [])]
    .join('\n')
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export function filterKnowledgeItems<T extends KnowledgeFilterable>(
  items: readonly T[],
  query: string
): T[] {
  const terms = parseKnowledgeQuery(query)
  if (terms.length === 0) return [...items]
  return items.filter((item) => matchesKnowledgeQuery(item, terms))
}

/**
 * Orders list rows. "recent" is newest-edited first, falling back to the name
 * order for rows with no timestamp so the result stays stable.
 */
export function sortKnowledgeItems<T extends KnowledgeFilterable>(
  items: readonly T[],
  mode: KnowledgeSortMode
): T[] {
  const byName = (left: T, right: T): number =>
    left.name.localeCompare(right.name)
  if (mode === 'name') return [...items].sort(byName)
  return [...items].sort((left, right) => {
    const l = left.draftSavedAt ?? ''
    const r = right.draftSavedAt ?? ''
    if (l === r) return byName(left, right)
    if (!l) return 1
    if (!r) return -1
    return l < r ? 1 : -1
  })
}
