import { extractInlineGuidance, parseSpaceDocument } from '../knowledge/spaceDocument.js';
import type { KnowledgeHarness } from '../knowledge/knowledgeHarness.js';
import type { GuidanceRule, GuidanceSourceLayer } from './ContextAssembler.js';

export interface KnowledgeAssemblyParts {
  guidance: GuidanceRule[];
  environment?: string;
  catalog?: string;
}

/**
 * Load environment facts, active guidance and catalog text for ContextAssembler.
 * Uses peek reads so answer provenance stays tied to explicit Harness tool reads.
 */
export async function buildKnowledgeAssemblyParts(
  harness: KnowledgeHarness,
  options: { pinnedModuleIds?: readonly string[] } = {},
): Promise<KnowledgeAssemblyParts> {
  const pinned = new Set(options.pinnedModuleIds ?? []);
  const overview = harness.listSessionOverview();
  const guidance: GuidanceRule[] = [];
  const environmentParts: string[] = [];
  let order = 0;

  for (const object of overview.readable) {
    let body: string;
    try {
      body = await harness.peekEntrySource(object.id, object.revision);
    } catch {
      continue;
    }

    if (object.kind === 'environment') {
      const facts = stripFrontmatter(body).trim();
      if (facts) environmentParts.push(`# ${object.name}\n${facts}`);
      continue;
    }

    let inline: string | undefined;
    try {
      inline = extractInlineGuidance(parseSpaceDocument(body));
    } catch {
      inline = undefined;
    }
    if (!inline?.trim()) continue;

    guidance.push({
      id: `${object.id}:SPACE.md:guidance`,
      text: inline.trim(),
      sourceLayer: resolveGuidanceLayer(object.access, object.id, pinned),
      order: order++,
      moduleId: object.id,
      moduleName: object.name,
      revision: object.revision,
      relativePath: 'SPACE.md',
    });
  }

  const catalog = overview.candidates.length > 0
    ? overview.candidates.map((entry) => (
      `${entry.name}: ${entry.description} (when: ${entry.whenToUse})`
    )).join('\n')
    : undefined;

  return {
    guidance,
    ...(environmentParts.length > 0 ? { environment: environmentParts.join('\n\n') } : {}),
    ...(catalog ? { catalog } : {}),
  };
}

function resolveGuidanceLayer(
  access: 'environment' | 'fixed' | 'dynamic',
  moduleId: string,
  pinned: ReadonlySet<string>,
): GuidanceSourceLayer {
  if (access === 'dynamic') return 'dynamic';
  if (pinned.has(moduleId)) return 'sessionPinned';
  return 'environmentAlways';
}

function stripFrontmatter(source: string): string {
  if (!source.startsWith('---')) return source;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return source;
  return source.slice(end + 4);
}
