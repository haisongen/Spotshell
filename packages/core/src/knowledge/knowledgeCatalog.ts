import type {
  PublishedEnvironmentSummary,
  PublishedKnowledgeModuleSummary,
} from './knowledgeRepository.js';

export type KnowledgeCatalogScope = 'environment' | 'session' | 'global';

export interface KnowledgeCatalogEntry {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  tags: string[];
  scope: KnowledgeCatalogScope;
}

export interface ResolvedKnowledgeCatalog {
  fixed: KnowledgeCatalogEntry[];
  candidates: {
    mode: 'inline' | 'query';
    total: number;
    entries: KnowledgeCatalogEntry[];
  };
}

export interface KnowledgeCatalogSources {
  availableModules?: readonly PublishedKnowledgeModuleSummary[];
  eligibleModules: readonly PublishedKnowledgeModuleSummary[];
  environment?: PublishedEnvironmentSummary;
  sessionAuthorizedIds?: readonly string[];
  globalAuthorizedIds?: readonly string[];
}

export interface KnowledgeCatalogOptions {
  catalogBudgetTokens: number;
}

export interface KnowledgeCatalogQuery {
  query?: string;
  cursor?: string;
  limit: number;
  resultBudgetTokens: number;
}

export interface KnowledgeCatalogQueryResult {
  entries: KnowledgeCatalogEntry[];
  nextCursor?: string;
}

export function resolveKnowledgeCatalog(
  sources: KnowledgeCatalogSources,
  options: KnowledgeCatalogOptions
): ResolvedKnowledgeCatalog {
  const { fixed, candidates } = collectCatalogEntries(sources);
  const inlineTokens = estimateSerializedTokens(candidates);
  return {
    fixed,
    candidates: {
      mode: inlineTokens <= options.catalogBudgetTokens ? 'inline' : 'query',
      total: candidates.length,
      entries: inlineTokens <= options.catalogBudgetTokens ? candidates : [],
    },
  };
}

export function queryKnowledgeCatalog(
  sources: KnowledgeCatalogSources,
  request: KnowledgeCatalogQuery
): KnowledgeCatalogQueryResult {
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
    throw new Error('Catalog query limit must be between 1 and 100');
  }
  if (!Number.isInteger(request.resultBudgetTokens) || request.resultBudgetTokens < 1) {
    throw new Error('Catalog query result budget must be a positive integer');
  }
  const query = normalizeSearchText(request.query ?? '');
  const offset = decodeCursor(request.cursor, query);
  const terms = query.split(' ').filter(Boolean);
  const scopeOrder: Record<KnowledgeCatalogScope, number> = {
    environment: 0,
    session: 1,
    global: 2,
  };
  const matches = collectCatalogEntries(sources).candidates
    .filter((entry) => {
      const metadata = normalizeSearchText([
        entry.id,
        entry.name,
        entry.description,
        entry.whenToUse,
        ...entry.tags,
      ].join(' '));
      return terms.every((term) => metadata.includes(term));
    })
    .sort((left, right) => scopeOrder[left.scope] - scopeOrder[right.scope]
      || compareCatalogEntries(left, right));
  if (offset > matches.length) throw new Error('Catalog query cursor is out of range');

  const entries: KnowledgeCatalogEntry[] = [];
  let resultTokens = 1;
  for (const entry of matches.slice(offset, offset + request.limit)) {
    const entryTokens = estimateSerializedTokens(entry);
    if (resultTokens + entryTokens > request.resultBudgetTokens) break;
    entries.push(entry);
    resultTokens += entryTokens;
  }
  if (entries.length === 0 && offset < matches.length) {
    throw new Error('Catalog query result budget is too small for one entry');
  }
  const nextOffset = offset + entries.length;
  return {
    entries,
    ...(nextOffset < matches.length ? { nextCursor: encodeCursor(query, nextOffset) } : {}),
  };
}

function collectCatalogEntries(sources: KnowledgeCatalogSources): {
  fixed: KnowledgeCatalogEntry[];
  candidates: KnowledgeCatalogEntry[];
} {
  const availableModules = new Map(
    (sources.availableModules ?? sources.eligibleModules).map((module) => [module.id, module])
  );
  const eligibleModules = new Map(
    sources.eligibleModules.map((module) => [module.id, module])
  );
  const fixedIds = new Set(sources.environment?.always ?? []);
  const fixed = entriesForIds(
    sources.environment?.always ?? [],
    availableModules,
    'environment'
  );
  const seen = new Set(fixedIds);
  const candidates = [
    ...entriesForIds(sources.environment?.onDemand ?? [], eligibleModules, 'environment'),
    ...entriesForIds(sources.sessionAuthorizedIds ?? [], eligibleModules, 'session'),
    ...entriesForIds(sources.globalAuthorizedIds ?? [], eligibleModules, 'global'),
  ].filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  return { fixed, candidates };
}

function entriesForIds(
  ids: readonly string[],
  modules: ReadonlyMap<string, PublishedKnowledgeModuleSummary>,
  scope: KnowledgeCatalogScope
): KnowledgeCatalogEntry[] {
  return ids.flatMap((id) => {
    const module = modules.get(id);
    return module ? [{
      id: module.id,
      name: module.name,
      description: module.description,
      whenToUse: module.whenToUse,
      tags: module.tags,
      scope,
    }] : [];
  });
}

function normalizeSearchText(value: string): string {
  return (value.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [])
    .join(' ');
}

function estimateSerializedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function compareCatalogEntries(
  left: KnowledgeCatalogEntry,
  right: KnowledgeCatalogEntry
): number {
  return left.name.toLocaleLowerCase('en-US').localeCompare(
    right.name.toLocaleLowerCase('en-US'),
    'en-US'
  ) || left.id.localeCompare(right.id, 'en-US');
}

function encodeCursor(query: string, offset: number): string {
  return Buffer.from(JSON.stringify({ query, offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, query: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded !== 'object'
      || decoded === null
      || !('query' in decoded)
      || decoded.query !== query
      || !('offset' in decoded)
      || !Number.isInteger(decoded.offset)
      || (decoded.offset as number) < 0
    ) {
      throw new Error('invalid cursor');
    }
    return decoded.offset as number;
  } catch {
    throw new Error('Invalid catalog query cursor');
  }
}
