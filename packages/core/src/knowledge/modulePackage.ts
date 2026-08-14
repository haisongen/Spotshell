import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { SPACE_SCHEMA_VERSION, SPACE_V1_LIMITS } from './limits.js';
import {
  assertManagedTextPath,
  ObjectRootError,
} from './safeObjectRoot.js';
import { scanKnowledgeSecrets } from './secretScanner.js';
import {
  parseSpaceDocument,
  serializeSpaceDocument,
  type SpaceDocument,
} from './spaceDocument.js';
import { loadSpaceObject } from './spaceObject.js';

export const MODULE_PACKAGE_FORMAT_VERSION = 1 as const;
export const MODULE_PACKAGE_KIND = 'knowledge-module' as const;

const packageFileSchema = z.object({
  relative_path: z.string().min(1).max(SPACE_V1_LIMITS.maxRelativePathChars),
  content: z.string(),
}).strict();

const knowledgeModulePackageSchema = z.object({
  format_version: z.literal(MODULE_PACKAGE_FORMAT_VERSION),
  package_kind: z.literal(MODULE_PACKAGE_KIND),
  schema_version: z.literal(SPACE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string().min(1),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  exported_at: z.string().datetime(),
  files: z.array(packageFileSchema).min(1).max(SPACE_V1_LIMITS.maxFilesPerObject),
}).strict();

export type KnowledgeModulePackageFile = z.infer<typeof packageFileSchema>;
export type KnowledgeModulePackage = z.infer<typeof knowledgeModulePackageSchema>;

export class ModulePackageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModulePackageError';
  }
}

export interface BuiltKnowledgeModulePackage {
  package: KnowledgeModulePackage;
  document: SpaceDocument;
  contentHash: string;
}

export type { KnowledgeModulePackage as PortableKnowledgeModulePackage };

/** Build a portable knowledge-module package from validated object files. */
export function buildKnowledgeModulePackage(input: {
  files: ReadonlyArray<{ relativePath: string; content: string }>;
  contentHash: string;
  exportedAt: string;
}): BuiltKnowledgeModulePackage {
  const byPath = new Map<string, string>();
  for (const file of input.files) {
    let relativePath: string;
    try {
      relativePath = assertManagedTextPath(file.relativePath);
    } catch (error) {
      throw new ModulePackageError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }
    if (relativePath === 'revision.json') {
      throw new ModulePackageError(
        'Package must not include system metadata file: revision.json'
      );
    }
    if (byPath.has(relativePath)) {
      throw new ModulePackageError(`Duplicate package file path: ${relativePath}`);
    }
    byPath.set(relativePath, file.content);
  }

  const entry = byPath.get('SPACE.md');
  if (entry === undefined) {
    throw new ModulePackageError('Knowledge module package must include SPACE.md');
  }

  let document: SpaceDocument;
  try {
    document = parseSpaceDocument(entry);
  } catch (error) {
    throw new ModulePackageError(
      error instanceof Error ? error.message : String(error),
      { cause: error }
    );
  }
  if (document.metadata.kind !== 'knowledge') {
    throw new ModulePackageError('Package SPACE.md must declare kind: knowledge');
  }
  if (document.metadata.schema_version !== SPACE_SCHEMA_VERSION) {
    throw new ModulePackageError(
      `Unsupported schema_version: ${document.metadata.schema_version}`
    );
  }

  // Normalize SPACE.md through the same serializer used for content hashing.
  byPath.set('SPACE.md', serializeSpaceDocument(document));

  for (const [relativePath, content] of byPath) {
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > SPACE_V1_LIMITS.maxFileBytes) {
      throw new ModulePackageError(
        `File exceeds ${SPACE_V1_LIMITS.maxFileBytes} bytes: ${relativePath}`
      );
    }
    const scan = scanKnowledgeSecrets(content);
    if (scan.status === 'blocked') {
      const finding = scan.findings[0];
      throw new ModulePackageError(
        `Package contains a possible secret (${finding?.ruleId ?? 'unknown'} at ${relativePath}:${finding?.line ?? 1})`
      );
    }
    if (scan.status === 'quarantined') {
      const finding = scan.findings[0];
      throw new ModulePackageError(
        `Package contains suspicious secret-like content (${finding?.ruleId ?? 'unknown'} at ${relativePath}:${finding?.line ?? 1})`
      );
    }
  }

  const totalBytes = [...byPath.values()]
    .reduce((sum, content) => sum + Buffer.byteLength(content, 'utf8'), 0);
  if (totalBytes > SPACE_V1_LIMITS.maxObjectBytes) {
    throw new ModulePackageError(
      `Package exceeds ${SPACE_V1_LIMITS.maxObjectBytes} bytes`
    );
  }

  const orderedPaths = [...byPath.keys()].sort((left, right) =>
    left.localeCompare(right, 'en-US')
  );
  const files: KnowledgeModulePackageFile[] = orderedPaths.map((relativePath) => ({
    relative_path: relativePath,
    content: byPath.get(relativePath)!,
  }));

  return {
    package: {
      format_version: MODULE_PACKAGE_FORMAT_VERSION,
      package_kind: MODULE_PACKAGE_KIND,
      schema_version: SPACE_SCHEMA_VERSION,
      id: document.metadata.id,
      name: document.metadata.name,
      content_hash: input.contentHash,
      exported_at: input.exportedAt,
      files,
    },
    document,
    contentHash: input.contentHash,
  };
}

export function serializeKnowledgeModulePackage(
  packageData: KnowledgeModulePackage
): string {
  return `${JSON.stringify(packageData, null, 2)}\n`;
}

/**
 * Parse and fully validate a portable knowledge-module package file.
 * Materializes content under stagingRoot so path sandbox + hash checks reuse loadSpaceObject.
 */
export async function loadAndValidateKnowledgeModulePackage(
  packagePath: string,
  stagingRoot: string,
): Promise<BuiltKnowledgeModulePackage> {
  let rawText: string;
  try {
    rawText = await fs.readFile(packagePath, 'utf8');
  } catch (error) {
    throw new ModulePackageError(
      `Unable to read knowledge module package: ${packagePath}`,
      { cause: error }
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawText);
  } catch (error) {
    throw new ModulePackageError('Knowledge module package is not valid JSON', {
      cause: error,
    });
  }

  let packageData: KnowledgeModulePackage;
  try {
    packageData = knowledgeModulePackageSchema.parse(decoded);
  } catch (error) {
    throw new ModulePackageError(
      error instanceof Error
        ? `Invalid knowledge module package: ${error.message}`
        : 'Invalid knowledge module package',
      { cause: error }
    );
  }

  // Reject absolute or host-local path leakage inside package metadata/content keys.
  for (const file of packageData.files) {
    if (
      path.isAbsolute(file.relative_path)
      || path.win32.isAbsolute(file.relative_path)
      || /^[A-Za-z]:/.test(file.relative_path)
      || file.relative_path.includes('\0')
    ) {
      throw new ModulePackageError(
        `Absolute or unsafe package path is not allowed: ${file.relative_path}`
      );
    }
  }

  const built = buildKnowledgeModulePackage({
    files: packageData.files.map((file) => ({
      relativePath: file.relative_path,
      content: file.content,
    })),
    contentHash: packageData.content_hash,
    exportedAt: packageData.exported_at,
  });

  if (built.package.id !== packageData.id) {
    throw new ModulePackageError(
      `Package id does not match SPACE.md stable id: package=${packageData.id} space=${built.package.id}`
    );
  }

  await fs.mkdir(stagingRoot, { recursive: true });
  for (const file of built.package.files) {
    const targetPath = path.join(stagingRoot, ...file.relative_path.split('/'));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, 'utf8');
  }

  let loaded;
  try {
    loaded = await loadSpaceObject(stagingRoot);
  } catch (error) {
    if (error instanceof ObjectRootError || error instanceof Error) {
      throw new ModulePackageError(error.message, { cause: error });
    }
    throw error;
  }

  if (loaded.document.metadata.kind !== 'knowledge') {
    throw new ModulePackageError('Imported package is not a knowledge module');
  }
  if (loaded.document.metadata.id !== packageData.id) {
    throw new ModulePackageError('Imported SPACE.md stable id does not match package id');
  }
  if (loaded.contentHash !== packageData.content_hash) {
    throw new ModulePackageError(
      `Package content hash mismatch: expected ${packageData.content_hash}, computed ${loaded.contentHash}`
    );
  }

  return {
    package: {
      ...built.package,
      content_hash: loaded.contentHash,
      name: loaded.document.metadata.name,
    },
    document: loaded.document,
    contentHash: loaded.contentHash,
  };
}

export function rewritePackageStableId(
  built: BuiltKnowledgeModulePackage,
  newId: string,
  exportedAt: string = built.package.exported_at,
): BuiltKnowledgeModulePackage {
  if (built.document.metadata.kind !== 'knowledge') {
    throw new ModulePackageError('Only knowledge modules can rewrite stable ids');
  }
  const rewrittenDocument: SpaceDocument = {
    metadata: {
      ...built.document.metadata,
      id: newId,
    },
    body: built.document.body,
  };
  const files = built.package.files.map((file) =>
    file.relative_path === 'SPACE.md'
      ? { relative_path: 'SPACE.md', content: serializeSpaceDocument(rewrittenDocument) }
      : file
  );
  // Content hash is recomputed by the caller after staging; keep prior hash only as placeholder.
  return buildKnowledgeModulePackage({
    files: files.map((file) => ({
      relativePath: file.relative_path,
      content: file.content,
    })),
    contentHash: built.contentHash,
    exportedAt,
  });
}
