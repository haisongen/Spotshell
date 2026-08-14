import {
  SafeObjectRoot,
  ObjectRootError,
  normalizeRelativePath,
} from './safeObjectRoot.js';
import { SPACE_V1_LIMITS } from './limits.js';
import { scanKnowledgeSecrets } from './secretScanner.js';
import {
  loadReasonForAccess,
  type KnowledgeContentType,
  type KnowledgeLoadReason,
  type KnowledgeProvenanceRecord,
} from './provenance.js';
import type { KnowledgeCatalogEntry, KnowledgeCatalogScope } from './knowledgeCatalog.js';

export type KnowledgeObjectAccess = 'environment' | 'fixed' | 'dynamic';

export interface KnowledgeObjectHandle {
  id: string;
  name: string;
  kind: 'environment' | 'knowledge';
  revision: number;
  contentHash: string;
  rootPath: string;
  access: KnowledgeObjectAccess;
  guidanceFiles?: readonly string[];
}

/** One dynamically selected module kept active for the current Agent context segment. */
export interface DynamicModuleSelection {
  moduleId: string;
  moduleName: string;
  revision: number;
  contentHash: string;
  reason: string;
  loadType: 'dynamic';
  scope?: KnowledgeCatalogScope;
}

export interface KnowledgeModuleSelectResult {
  selection: DynamicModuleSelection;
  content: string;
  provenance: KnowledgeProvenanceRecord;
}

export interface KnowledgeHarnessConfig {
  objects: readonly KnowledgeObjectHandle[];
  catalog?: readonly KnowledgeCatalogEntry[];
  /**
   * Authorized candidate modules that are not yet active/readable.
   * Possession alone is insufficient — only IDs present here (or already in objects)
   * may be activated mid-turn by the Agent tool loop.
   */
  activatable?: readonly KnowledgeObjectHandle[];
}

export interface KnowledgeReadResult {
  content: string;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  provenance: KnowledgeProvenanceRecord;
}

export interface KnowledgeFileListResult {
  files: Array<{ relativePath: string; sizeBytes: number }>;
}

export interface KnowledgeSearchOptions {
  pattern: string;
  mode: 'literal' | 'regex';
  maxMatches?: number;
  ignoreCase?: boolean;
}

export interface KnowledgeSearchMatch {
  relativePath: string;
  line: number;
  preview: string;
  provenance: KnowledgeProvenanceRecord;
}

export interface KnowledgeSearchResult {
  matches: KnowledgeSearchMatch[];
  truncated: boolean;
}

export interface KnowledgeLineReadOptions {
  startLine: number;
  maxLines?: number;
}

export class KnowledgeHarnessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KnowledgeHarnessError';
  }
}

export class KnowledgeHarness {
  private readonly objects = new Map<string, KnowledgeObjectHandle>();
  private readonly activatable = new Map<string, KnowledgeObjectHandle>();
  private readonly catalog: readonly KnowledgeCatalogEntry[];
  private readonly dynamicSelections = new Map<string, DynamicModuleSelection>();
  private provenance: KnowledgeProvenanceRecord[] = [];
  /** Per-object memo of entry/body reads and search payloads for the active revision. */
  private readonly objectMaterial = new Map<string, Map<string, string>>();

  constructor(config: KnowledgeHarnessConfig) {
    for (const object of config.objects) {
      this.objects.set(object.id, object);
      if (object.access === 'dynamic' && object.kind === 'knowledge') {
        this.dynamicSelections.set(object.id, {
          moduleId: object.id,
          moduleName: object.name,
          revision: object.revision,
          contentHash: object.contentHash,
          reason: 'previously active in this context segment',
          loadType: 'dynamic',
          scope: config.catalog?.find((entry) => entry.id === object.id)?.scope,
        });
      }
    }
    for (const candidate of config.activatable ?? []) {
      if (this.objects.has(candidate.id)) continue;
      this.activatable.set(candidate.id, candidate);
    }
    this.catalog = config.catalog ?? [];
  }

  /**
   * Replace one active object handle (revision pin + root) and clear only that
   * object's entry/guidance/search/body material. Other objects stay untouched.
   */
  replaceActiveObject(handle: KnowledgeObjectHandle): void {
    if (!this.objects.has(handle.id) && !this.activatable.has(handle.id)) {
      throw new KnowledgeHarnessError(
        `Knowledge object is not authorized or not selected for this session: ${handle.id}`
      );
    }
    this.objects.set(handle.id, handle);
    this.activatable.delete(handle.id);
    const selection = this.dynamicSelections.get(handle.id);
    if (selection) {
      this.dynamicSelections.set(handle.id, {
        ...selection,
        moduleName: handle.name,
        revision: handle.revision,
        contentHash: handle.contentHash,
      });
    }
    this.clearObjectMaterial(handle.id);
  }

  /** Drop cached entry, guidance, search results and body fragments for one object. */
  clearObjectMaterial(objectId: string): void {
    this.objectMaterial.delete(objectId);
    this.provenance = this.provenance.filter((record) => record.objectId !== objectId);
  }

  listEligibleMetadata(): KnowledgeCatalogEntry[] {
    return this.catalog.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      whenToUse: entry.whenToUse,
      tags: [...entry.tags],
      scope: entry.scope,
    }));
  }

  /** Session overview: currently readable objects (with active revision) plus candidate metadata. */
  listSessionOverview(): {
    readable: Array<{
      id: string;
      name: string;
      kind: 'environment' | 'knowledge';
      revision: number;
      contentHash: string;
      access: KnowledgeObjectAccess;
    }>;
    candidates: Array<KnowledgeCatalogEntry & { revision?: number; contentHash?: string }>;
  } {
    const readable = [...this.objects.values()]
      .map((object) => ({
        id: object.id,
        name: object.name,
        kind: object.kind,
        revision: object.revision,
        contentHash: object.contentHash,
        access: object.access,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    const candidates = this.listEligibleMetadata().map((entry) => {
      const handle = this.activatable.get(entry.id) ?? this.objects.get(entry.id);
      return handle
        ? { ...entry, revision: handle.revision, contentHash: handle.contentHash }
        : entry;
    });
    return {
      readable,
      candidates,
    };
  }

  listActiveDynamicSelections(): DynamicModuleSelection[] {
    return [...this.dynamicSelections.values()];
  }

  /**
   * Activate an authorized candidate in the current Agent tool loop.
   * Returns the SPACE.md entry so the model can progressive-read without a hidden router call.
   * Already-active modules keep their original selection reason.
   */
  async selectModule(objectId: string, reason: string): Promise<KnowledgeModuleSelectResult> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new KnowledgeHarnessError('Selection reason must not be empty');
    }

    const existingSelection = this.dynamicSelections.get(objectId);
    let handle = this.objects.get(objectId);

    if (!handle) {
      const candidate = this.activatable.get(objectId);
      if (!candidate || candidate.kind !== 'knowledge') {
        throw new KnowledgeHarnessError(
          `Knowledge object is not an authorized candidate for this session: ${objectId}`
        );
      }
      handle = { ...candidate, access: 'dynamic' };
      this.objects.set(objectId, handle);
      this.activatable.delete(objectId);
    } else if (handle.kind !== 'knowledge') {
      throw new KnowledgeHarnessError(
        `Only knowledge modules can be dynamically selected: ${objectId}`
      );
    } else if (handle.access === 'environment') {
      throw new KnowledgeHarnessError(
        `Environment profiles cannot be dynamically selected: ${objectId}`
      );
    } else if (handle.access === 'fixed' && !existingSelection) {
      // Fixed/pinned modules are already readable; return entry without changing dynamic set.
      const entry = await this.readEntry(handle.id, handle.revision);
      return {
        selection: {
          moduleId: handle.id,
          moduleName: handle.name,
          revision: handle.revision,
          contentHash: handle.contentHash,
          reason: trimmedReason,
          loadType: 'dynamic',
          scope: this.catalog.find((entry) => entry.id === objectId)?.scope,
        },
        content: entry.content,
        provenance: entry.provenance,
      };
    } else if (handle.access !== 'dynamic' && !existingSelection) {
      // Promote a non-dynamic readable knowledge module only via activatable path above.
      throw new KnowledgeHarnessError(
        `Knowledge object is not an authorized candidate for this session: ${objectId}`
      );
    }

    const selection = existingSelection ?? {
      moduleId: handle.id,
      moduleName: handle.name,
      revision: handle.revision,
      contentHash: handle.contentHash,
      reason: trimmedReason,
      loadType: 'dynamic' as const,
      scope: this.catalog.find((entry) => entry.id === objectId)?.scope,
    };
    if (!existingSelection) {
      this.dynamicSelections.set(objectId, selection);
    }

    const entry = await this.readEntry(handle.id, handle.revision);
    return {
      selection,
      content: entry.content,
      provenance: entry.provenance,
    };
  }

  async readEntry(objectId: string, revision: number): Promise<KnowledgeReadResult> {
    const handle = this.requireObject(objectId, revision);
    const content = await this.readSpaceSource(handle);
    const lines = splitLines(content);
    const provenance = this.recordProvenance(handle, {
      relativePath: 'SPACE.md',
      startLine: 1,
      endLine: Math.max(lines.length, 1),
      contentType: 'entry',
      loadReason: 'entry-read',
    });
    return {
      content,
      startLine: 1,
      endLine: Math.max(lines.length, 1),
      hasMore: false,
      provenance,
    };
  }

  /**
   * Read SPACE.md for context assembly without recording answer provenance.
   * Secrets are still scanned and blocked.
   */
  async peekEntrySource(objectId: string, revision: number): Promise<string> {
    const handle = this.requireObject(objectId, revision);
    return this.readSpaceSource(handle);
  }

  async listTextFiles(objectId: string, revision: number): Promise<KnowledgeFileListResult> {
    const handle = this.requireObject(objectId, revision);
    const root = await SafeObjectRoot.open(handle.rootPath);
    const files = (await root.listTextFiles()).filter((file) => isKnowledgeContentFile(file.relativePath));
    return {
      files: files.map((file) => ({
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
      })),
    };
  }

  async searchText(
    objectId: string,
    revision: number,
    options: KnowledgeSearchOptions
  ): Promise<KnowledgeSearchResult> {
    const handle = this.requireObject(objectId, revision);
    const maxMatches = clampInteger(
      options.maxMatches ?? SPACE_V1_LIMITS.maxSearchMatches,
      1,
      SPACE_V1_LIMITS.maxSearchMatches
    );
    const cacheKey = [
      'search',
      String(revision),
      options.mode,
      options.ignoreCase ? 'i' : 's',
      String(maxMatches),
      options.pattern,
    ].join(':');
    const cached = this.getObjectMaterial(handle.id, cacheKey);
    if (cached !== undefined) {
      const parsed = JSON.parse(cached) as KnowledgeSearchResult;
      for (const match of parsed.matches) {
        match.provenance = this.recordProvenance(handle, {
          relativePath: match.relativePath,
          startLine: match.line,
          endLine: match.line,
          contentType: 'search-preview',
          loadReason: 'search',
        });
      }
      return parsed;
    }

    const root = await SafeObjectRoot.open(handle.rootPath);
    const files = (await root.listTextFiles()).filter((file) => isKnowledgeContentFile(file.relativePath));
    const matcher = createMatcher(options);
    const startedAt = Date.now();
    const matches: KnowledgeSearchMatch[] = [];
    let truncated = false;

    for (const file of files) {
      this.assertCleanSecrets(file.content, file.relativePath);
      const lines = splitLines(file.content);
      for (let index = 0; index < lines.length; index += 1) {
        if (Date.now() - startedAt > SPACE_V1_LIMITS.maxRegexExecutionMs) {
          throw new KnowledgeHarnessError(
            `Knowledge search exceeded ${SPACE_V1_LIMITS.maxRegexExecutionMs}ms`
          );
        }
        const lineText = lines[index] ?? '';
        if (!matcher(lineText)) continue;
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
        const lineNumber = index + 1;
        const preview = truncatePreview(lineText);
        const provenance = this.recordProvenance(handle, {
          relativePath: file.relativePath,
          startLine: lineNumber,
          endLine: lineNumber,
          contentType: 'search-preview',
          loadReason: 'search',
        });
        matches.push({
          relativePath: file.relativePath,
          line: lineNumber,
          preview,
          provenance,
        });
      }
      if (truncated) break;
    }

    const result = { matches, truncated };
    this.setObjectMaterial(
      handle.id,
      cacheKey,
      JSON.stringify({
        matches: matches.map(({ relativePath, line, preview }) => ({
          relativePath,
          line,
          preview,
        })),
        truncated,
      }),
    );
    return result;
  }

  async readLines(
    objectId: string,
    revision: number,
    relativePath: string,
    options: KnowledgeLineReadOptions
  ): Promise<KnowledgeReadResult> {
    const handle = this.requireObject(objectId, revision);
    if (!Number.isInteger(options.startLine) || options.startLine < 1) {
      throw new KnowledgeHarnessError('startLine must be a positive integer');
    }
    const maxLines = clampInteger(
      options.maxLines ?? SPACE_V1_LIMITS.maxReadLines,
      1,
      SPACE_V1_LIMITS.maxReadLines
    );
    const normalizedPath = normalizeRelativePathSafe(relativePath);
    if (!isKnowledgeContentFile(normalizedPath)) {
      throw new KnowledgeHarnessError(
        `System metadata files are not readable as knowledge content: ${normalizedPath}`
      );
    }
    const cacheKey = `body:${revision}:${normalizedPath}:${options.startLine}:${maxLines}`;
    const cachedBody = this.getObjectMaterial(handle.id, cacheKey);
    if (cachedBody !== undefined) {
      const parsed = JSON.parse(cachedBody) as {
        content: string;
        startLine: number;
        endLine: number;
        hasMore: boolean;
      };
      const provenance = this.recordProvenance(handle, {
        relativePath: normalizedPath,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        contentType: contentTypeForPath(handle, normalizedPath),
        loadReason: 'line-read',
      });
      return { ...parsed, provenance };
    }

    const root = await SafeObjectRoot.open(handle.rootPath);
    let file;
    try {
      file = await root.readText(normalizedPath);
    } catch (error) {
      throw toHarnessError(error);
    }
    this.assertCleanSecrets(file.content, normalizedPath);

    const lines = splitLines(file.content);
    const startIndex = options.startLine - 1;
    if (startIndex >= lines.length) {
      throw new KnowledgeHarnessError(
        `startLine ${options.startLine} is past the end of ${normalizedPath}`
      );
    }
    const slice = lines.slice(startIndex, startIndex + maxLines);
    let content = slice.join('\n');
    if (content.length > SPACE_V1_LIMITS.maxReadBytes) {
      content = content.slice(0, SPACE_V1_LIMITS.maxReadBytes);
    }
    const endLine = options.startLine + slice.length - 1;
    const hasMore = endLine < lines.length;
    const provenance = this.recordProvenance(handle, {
      relativePath: normalizedPath,
      startLine: options.startLine,
      endLine,
      contentType: contentTypeForPath(handle, normalizedPath),
      loadReason: 'line-read',
    });
    this.setObjectMaterial(
      handle.id,
      cacheKey,
      JSON.stringify({
        content,
        startLine: options.startLine,
        endLine,
        hasMore,
      }),
    );
    return {
      content,
      startLine: options.startLine,
      endLine,
      hasMore,
      provenance,
    };
  }

  takeProvenance(): KnowledgeProvenanceRecord[] {
    const records = this.provenance;
    this.provenance = [];
    return records;
  }

  peekProvenance(): readonly KnowledgeProvenanceRecord[] {
    return this.provenance;
  }

  private requireObject(objectId: string, revision: number): KnowledgeObjectHandle {
    const handle = this.objects.get(objectId);
    if (!handle) {
      throw new KnowledgeHarnessError(
        `Knowledge object is not authorized or not selected for this session: ${objectId}`
      );
    }
    if (handle.revision !== revision) {
      throw new KnowledgeHarnessError(
        `Active revision mismatch for ${objectId}: expected ${handle.revision}, got ${revision}`
      );
    }
    return handle;
  }

  private async readSpaceSource(handle: KnowledgeObjectHandle): Promise<string> {
    const cacheKey = `entry:${handle.revision}:SPACE.md`;
    const cached = this.getObjectMaterial(handle.id, cacheKey);
    if (cached !== undefined) return cached;
    const root = await SafeObjectRoot.open(handle.rootPath);
    const file = await root.readText('SPACE.md');
    this.assertCleanSecrets(file.content, 'SPACE.md');
    this.setObjectMaterial(handle.id, cacheKey, file.content);
    return file.content;
  }

  private getObjectMaterial(objectId: string, key: string): string | undefined {
    return this.objectMaterial.get(objectId)?.get(key);
  }

  private setObjectMaterial(objectId: string, key: string, value: string): void {
    let bucket = this.objectMaterial.get(objectId);
    if (!bucket) {
      bucket = new Map();
      this.objectMaterial.set(objectId, bucket);
    }
    bucket.set(key, value);
  }

  private recordProvenance(
    handle: KnowledgeObjectHandle,
    details: {
      relativePath: string;
      startLine: number;
      endLine: number;
      contentType: KnowledgeContentType;
      loadReason: KnowledgeLoadReason;
    }
  ): KnowledgeProvenanceRecord {
    const record: KnowledgeProvenanceRecord = {
      objectId: handle.id,
      objectName: handle.name,
      objectKind: handle.kind,
      revision: handle.revision,
      contentHash: handle.contentHash,
      relativePath: details.relativePath,
      startLine: details.startLine,
      endLine: details.endLine,
      contentType: details.contentType,
      loadReason: details.loadReason === 'entry-read'
        ? 'entry-read'
        : details.loadReason === 'search' || details.loadReason === 'line-read'
          ? details.loadReason
          : loadReasonForAccess(handle.access),
    };
    this.provenance.push(record);
    return record;
  }

  private assertCleanSecrets(content: string, relativePath: string): void {
    const scan = scanKnowledgeSecrets(content);
    if (scan.status === 'clean') return;
    const finding = scan.findings[0];
    throw new KnowledgeHarnessError(
      `Secret-isolated content blocked for ${relativePath}` +
        (finding ? ` (${finding.ruleId} at line ${finding.line})` : '')
    );
  }
}

/** Managed revision metadata must never be exposed as knowledge body content. */
function isKnowledgeContentFile(relativePath: string): boolean {
  return relativePath !== 'revision.json';
}

function contentTypeForPath(
  handle: KnowledgeObjectHandle,
  relativePath: string
): KnowledgeContentType {
  if (relativePath === 'SPACE.md') return 'entry';
  const guidanceFiles = new Set(
    (handle.guidanceFiles ?? []).map((value) => normalizeRelativePathSafe(value))
  );
  if (guidanceFiles.has(relativePath)) return 'guidance';
  return 'reference';
}

function createMatcher(options: KnowledgeSearchOptions): (line: string) => boolean {
  if (!options.pattern) {
    throw new KnowledgeHarnessError('Search pattern must not be empty');
  }
  if (options.pattern.length > SPACE_V1_LIMITS.maxRegexPatternChars) {
    throw new KnowledgeHarnessError(
      `Search pattern exceeds ${SPACE_V1_LIMITS.maxRegexPatternChars} characters`
    );
  }
  if (options.mode === 'literal') {
    const needle = options.ignoreCase
      ? options.pattern.toLocaleLowerCase('en-US')
      : options.pattern;
    return (line) => {
      const haystack = options.ignoreCase ? line.toLocaleLowerCase('en-US') : line;
      return haystack.includes(needle);
    };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, options.ignoreCase ? 'i' : undefined);
  } catch (error) {
    throw new KnowledgeHarnessError(
      `Invalid regular expression: ${(error as Error).message}`,
      { cause: error }
    );
  }
  return (line) => regex.test(line);
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function truncatePreview(line: string): string {
  if (line.length <= SPACE_V1_LIMITS.maxSearchPreviewChars) return line;
  return line.slice(0, SPACE_V1_LIMITS.maxSearchPreviewChars);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) {
    throw new KnowledgeHarnessError('Numeric limits must be integers');
  }
  return Math.min(Math.max(value, min), max);
}

function normalizeRelativePathSafe(relativePath: string): string {
  try {
    return normalizeRelativePath(relativePath);
  } catch (error) {
    throw toHarnessError(error);
  }
}

function toHarnessError(error: unknown): KnowledgeHarnessError {
  if (error instanceof KnowledgeHarnessError) return error;
  if (error instanceof ObjectRootError) {
    return new KnowledgeHarnessError(error.message, { cause: error });
  }
  return new KnowledgeHarnessError(
    error instanceof Error ? error.message : String(error),
    { cause: error }
  );
}
