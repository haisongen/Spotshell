import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import { toString as markdownToString } from 'mdast-util-to-string';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { SPACE_SCHEMA_VERSION, SPACE_V1_LIMITS } from './limits.js';
import { normalizeRelativePath } from './safeObjectRoot.js';

const stableIdSchema = z.string().uuid().refine(
  (value) => value === value.toLocaleLowerCase('en-US'),
  'Stable IDs must use canonical lowercase UUIDs'
);
const nonEmptyTextSchema = z.string().trim().min(1);

const commonMetadataShape = {
  schema_version: z.literal(SPACE_SCHEMA_VERSION),
  id: stableIdSchema,
  name: nonEmptyTextSchema.max(100),
  description: nonEmptyTextSchema.max(500),
  tags: z.array(nonEmptyTextSchema.max(50)).max(20).optional(),
};

const knowledgeMetadataSchema = z.object({
  ...commonMetadataShape,
  kind: z.literal('knowledge'),
  when_to_use: nonEmptyTextSchema.max(500),
  when_not_to_use: nonEmptyTextSchema.max(500).optional(),
  guidance_files: z.array(nonEmptyTextSchema.max(240))
    .max(SPACE_V1_LIMITS.maxGuidanceFiles)
    .optional(),
}).strict();

const environmentMetadataSchema = z.object({
  ...commonMetadataShape,
  kind: z.literal('environment'),
  modules: z.object({
    always: z.array(stableIdSchema).max(64),
    on_demand: z.array(stableIdSchema).max(64),
  }).strict(),
}).strict();

const spaceMetadataSchema = z.discriminatedUnion('kind', [
  knowledgeMetadataSchema,
  environmentMetadataSchema,
]).superRefine((metadata, context) => {
  assertUniqueStrings(metadata.tags, ['tags'], context);
  if (metadata.kind === 'knowledge') {
    assertGuidancePaths(metadata.guidance_files, context);
  } else {
    const moduleIds = [...metadata.modules.always, ...metadata.modules.on_demand];
    const seen = new Set<string>();
    for (const moduleId of moduleIds) {
      if (seen.has(moduleId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate module stable ID: ${moduleId}`,
          path: ['modules'],
        });
      }
      seen.add(moduleId);
    }
  }
});

export type KnowledgeSpaceMetadata = z.infer<typeof knowledgeMetadataSchema>;
export type EnvironmentSpaceMetadata = z.infer<typeof environmentMetadataSchema>;
export type SpaceMetadata = z.infer<typeof spaceMetadataSchema>;

export interface SpaceDocument {
  metadata: SpaceMetadata;
  body: string;
}

export interface SpaceForm {
  metadata: SpaceMetadata;
  beforeGuidance: string;
  inlineGuidance?: string;
  afterGuidance: string;
}

interface GuidanceSection {
  content: string;
  headingStartOffset: number;
  contentEndOffset: number;
}

export class SpaceDocumentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SpaceDocumentError';
  }
}

export function parseSpaceDocument(source: string): SpaceDocument {
  const tree = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .parse(source);
  const frontmatterNodes = tree.children.filter((node) => node.type === 'yaml');
  if (frontmatterNodes.length !== 1 || tree.children[0] !== frontmatterNodes[0]) {
    throw new SpaceDocumentError('SPACE.md must start with exactly one YAML frontmatter block');
  }

  const frontmatter = frontmatterNodes[0];
  if (frontmatter.type !== 'yaml' || frontmatter.position?.end.offset === undefined) {
    throw new SpaceDocumentError('SPACE.md YAML frontmatter has no source position');
  }

  const yamlDocument = parseDocument(frontmatter.value, { uniqueKeys: true });
  if (yamlDocument.errors.length > 0) {
    throw new SpaceDocumentError(
      `Invalid SPACE.md YAML: ${yamlDocument.errors.map((error) => error.message).join('; ')}`
    );
  }

  let decoded: unknown;
  try {
    decoded = yamlDocument.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new SpaceDocumentError('Invalid SPACE.md YAML value', { cause: error });
  }

  const parsed = spaceMetadataSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new SpaceDocumentError(`Invalid SPACE.md metadata: ${parsed.error.message}`);
  }

  const guidanceSection = findGuidanceSection(tree, source);
  if (parsed.data.kind === 'environment' && guidanceSection !== undefined) {
    throw new SpaceDocumentError('An environment SPACE.md must not contain ## Guidance');
  }

  return {
    metadata: parsed.data,
    body: normalizeBody(source.slice(frontmatter.position.end.offset)),
  };
}

/**
 * Raw text of the single leading `---` YAML frontmatter block, if the source is
 * structurally shaped like a SPACE.md (same detection rule as parseSpaceDocument).
 * Returns undefined when there is no frontmatter, more than one block, or it
 * isn't the first node — callers decide what to do in that case.
 */
function extractLeadingFrontmatterBlock(source: string): string | undefined {
  const tree = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).parse(source);
  const frontmatterNodes = tree.children.filter((node) => node.type === 'yaml');
  if (frontmatterNodes.length !== 1 || tree.children[0] !== frontmatterNodes[0]) return undefined;
  const frontmatter = frontmatterNodes[0];
  if (frontmatter.position?.start.offset === undefined || frontmatter.position.end.offset === undefined) {
    return undefined;
  }
  return source.slice(frontmatter.position.start.offset, frontmatter.position.end.offset);
}

/**
 * Safety net for knowledge proposals: an AI-authored `after` sometimes drops the
 * entire YAML frontmatter block while only meaning to edit the body (it is
 * mechanical metadata the model has no reason to reproduce verbatim). When
 * `after` has no frontmatter at all but `before` did, splice the original
 * frontmatter back on rather than forcing the user to hand-retype YAML.
 * Leaves `after` untouched whenever it already has a leading frontmatter block,
 * even a broken one — that is a deliberate edit and must fail validation loudly.
 */
export function repairMissingSpaceFrontmatter(before: string, after: string): string {
  if (extractLeadingFrontmatterBlock(after) !== undefined) return after;
  const beforeFrontmatter = extractLeadingFrontmatterBlock(before);
  if (beforeFrontmatter === undefined) return after;
  return `${beforeFrontmatter}\n\n${normalizeBody(after)}`;
}

/**
 * A line the author meant as a top-level heading but wrote without the space
 * CommonMark requires (`##Hadoop 巡检`). remark parses those as paragraph text,
 * so without this they never terminate the preceding section. Only depths 1-2
 * count, matching the real-heading rule in `isSectionBoundaryNode`.
 */
const SPACELESS_HEADING_PATTERN = /^#{1,2}[^#\s]/;

/** True when a top-level node ends the section that precedes it. */
function isSectionBoundaryNode(node: RootContent, source: string): boolean {
  if (node.type === 'heading') return node.depth <= 2;
  // Only a paragraph can carry a spaceless heading — fenced code keeps its
  // `#comment` / `#!/bin/bash` lines inside a `code` node, out of reach here.
  // Check every line, not just the first: without a blank line before it, the
  // `##Foo` line is a continuation of the preceding paragraph's node.
  if (node.type !== 'paragraph') return false;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  for (const line of source.slice(start, end).split('\n')) {
    if (SPACELESS_HEADING_PATTERN.test(line)) return true;
  }
  return false;
}

/**
 * Guidance body of a raw SPACE.md source (frontmatter included), or '' when the
 * document has no `## Guidance`. Unlike `findGuidanceSection` this never throws:
 * promotion checks run against arbitrary proposal content, including documents
 * that are malformed enough to fail validation later.
 */
export function extractGuidanceBody(source: string): string {
  let tree: Root;
  try {
    tree = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).parse(source);
  } catch {
    return '';
  }
  const guidanceIndex = tree.children.findIndex((node) =>
    node.type === 'heading' && node.depth === 2 && markdownToString(node) === 'Guidance'
  );
  if (guidanceIndex < 0) return '';
  const startOffset = tree.children[guidanceIndex]!.position?.end.offset;
  if (startOffset === undefined) return '';
  const boundary = tree.children.slice(guidanceIndex + 1).find((node) =>
    isSectionBoundaryNode(node, source)
  );
  const endOffset = boundary?.position?.start.offset ?? source.length;
  return source.slice(startOffset, endOffset).replace(/\r\n?/g, '\n').trim();
}

export function extractInlineGuidance(document: SpaceDocument): string | undefined {
  const tree = unified().use(remarkParse).parse(document.body);
  return findGuidanceSection(tree, document.body)?.content;
}

export function hasSubstantiveSpaceContent(document: SpaceDocument): boolean {
  const tree = unified().use(remarkParse).parse(document.body);
  return tree.children.some((node) => {
    if (node.type === 'heading' || node.type === 'thematicBreak') return false;
    return markdownToString(node).trim().length > 0;
  });
}

export function toSpaceForm(document: SpaceDocument): SpaceForm {
  const tree = unified().use(remarkParse).parse(document.body);
  const guidanceSection = findGuidanceSection(tree, document.body);
  if (!guidanceSection) {
    return {
      metadata: spaceMetadataSchema.parse(document.metadata),
      beforeGuidance: normalizeBody(document.body),
      afterGuidance: '',
    };
  }
  return {
    metadata: spaceMetadataSchema.parse(document.metadata),
    beforeGuidance: normalizeBody(document.body.slice(0, guidanceSection.headingStartOffset)),
    inlineGuidance: guidanceSection.content,
    afterGuidance: normalizeBody(document.body.slice(guidanceSection.contentEndOffset)),
  };
}

export function spaceDocumentFromForm(form: SpaceForm): SpaceDocument {
  const parts = [normalizeBody(form.beforeGuidance).trimEnd()];
  if (form.inlineGuidance !== undefined) {
    parts.push('## Guidance');
    const guidance = normalizeBody(form.inlineGuidance).trimEnd();
    if (guidance) parts.push(guidance);
  }
  const afterGuidance = normalizeBody(form.afterGuidance).trimEnd();
  if (afterGuidance) parts.push(afterGuidance);
  const document: SpaceDocument = {
    metadata: spaceMetadataSchema.parse(form.metadata),
    body: normalizeBody(parts.filter(Boolean).join('\n\n')),
  };
  return parseSpaceDocument(serializeSpaceDocument(document));
}

export function assertUniqueSpaceIds(documents: readonly SpaceDocument[]): void {
  const ids = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.metadata.id)) {
      throw new SpaceDocumentError(
        `Duplicate SPACE.md stable ID: ${document.metadata.id}`
      );
    }
    ids.add(document.metadata.id);
  }
}

export function serializeSpaceDocument(document: SpaceDocument): string {
  const metadata = spaceMetadataSchema.parse(document.metadata);
  const yaml = stringify(metadata, { lineWidth: 0 }).trimEnd();
  const body = normalizeBody(document.body);
  return `---\n${yaml}\n---\n\n${body}`;
}

function normalizeBody(body: string): string {
  const normalized = body.replace(/\r\n?/g, '\n').replace(/^\n+/, '').trimEnd();
  return normalized ? `${normalized}\n` : '';
}

function findGuidanceSection(
  tree: Root,
  source: string
): GuidanceSection | undefined {
  const guidanceIndexes: number[] = [];
  for (const [index, node] of tree.children.entries()) {
    if (node.type === 'heading' && node.depth === 2 && markdownToString(node) === 'Guidance') {
      guidanceIndexes.push(index);
    }
  }
  if (guidanceIndexes.length > 1) {
    throw new SpaceDocumentError('Knowledge SPACE.md must not contain duplicate ## Guidance sections');
  }
  const guidanceIndex = guidanceIndexes[0];
  if (guidanceIndex === undefined) return undefined;

  const heading = tree.children[guidanceIndex]!;
  const startOffset = heading.position?.end.offset;
  if (startOffset === undefined) {
    throw new SpaceDocumentError('SPACE.md Guidance section has no source position');
  }
  const nextBoundary = tree.children.slice(guidanceIndex + 1).find((node) =>
    isSectionBoundaryNode(node, source)
  );
  const endOffset = nextBoundary?.position?.start.offset ?? source.length;
  const headingStartOffset = heading.position?.start.offset;
  if (headingStartOffset === undefined) {
    throw new SpaceDocumentError('SPACE.md Guidance heading has no source position');
  }
  return {
    content: normalizeBody(source.slice(startOffset, endOffset)),
    headingStartOffset,
    contentEndOffset: endOffset,
  };
}

function assertUniqueStrings(
  values: string[] | undefined,
  path: (string | number)[],
  context: z.RefinementCtx
): void {
  if (!values) return;
  const normalized = new Set<string>();
  for (const [index, value] of values.entries()) {
    const key = value.toLocaleLowerCase('en-US');
    if (normalized.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate value: ${value}`,
        path: [...path, index],
      });
    }
    normalized.add(key);
  }
}

function assertGuidancePaths(
  values: string[] | undefined,
  context: z.RefinementCtx
): void {
  if (!values) return;
  const normalizedPaths = new Set<string>();
  for (const [index, value] of values.entries()) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRelativePath(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid guidance file path',
        path: ['guidance_files', index],
      });
      continue;
    }

    const key = normalizedPath.toLocaleLowerCase('en-US');
    if (key === 'space.md') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'guidance_files must not reference SPACE.md',
        path: ['guidance_files', index],
      });
    }
    if (normalizedPaths.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate guidance file path: ${normalizedPath}`,
        path: ['guidance_files', index],
      });
    }
    normalizedPaths.add(key);
  }
}
