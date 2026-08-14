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
import {
  buildKnowledgeModulePackage,
  ModulePackageError,
  type BuiltKnowledgeModulePackage,
  type KnowledgeModulePackageFile,
} from './modulePackage.js';
import { loadSpaceObject } from './spaceObject.js';

export const ENVIRONMENT_PACKAGE_FORMAT_VERSION = 1 as const;
export const ENVIRONMENT_BUNDLE_KIND = 'environment-bundle' as const;
export const ENVIRONMENT_DEFINITION_KIND = 'environment-definition' as const;

const packageFileSchema = z.object({
  relative_path: z.string().min(1).max(SPACE_V1_LIMITS.maxRelativePathChars),
  content: z.string(),
}).strict();

const packagedObjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(packageFileSchema).min(1).max(SPACE_V1_LIMITS.maxFilesPerObject),
}).strict();

const environmentPackageSchema = z.object({
  format_version: z.literal(ENVIRONMENT_PACKAGE_FORMAT_VERSION),
  package_kind: z.enum([ENVIRONMENT_BUNDLE_KIND, ENVIRONMENT_DEFINITION_KIND]),
  schema_version: z.literal(SPACE_SCHEMA_VERSION),
  exported_at: z.string().datetime(),
  environment: packagedObjectSchema,
  modules: z.array(packagedObjectSchema).max(128),
}).strict();

export type EnvironmentPackageFile = z.infer<typeof packageFileSchema>;
export type PackagedObjectPayload = z.infer<typeof packagedObjectSchema>;
export type EnvironmentPackage = z.infer<typeof environmentPackageSchema>;
export type EnvironmentPackageKind =
  | typeof ENVIRONMENT_BUNDLE_KIND
  | typeof ENVIRONMENT_DEFINITION_KIND;

export class EnvironmentPackageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EnvironmentPackageError';
  }
}

export interface BuiltEnvironmentObject {
  payload: PackagedObjectPayload;
  document: SpaceDocument;
  contentHash: string;
}

export interface BuiltEnvironmentPackage {
  package: EnvironmentPackage;
  environment: BuiltEnvironmentObject;
  modules: BuiltKnowledgeModulePackage[];
}

function collectPackageFiles(
  input: ReadonlyArray<{ relativePath: string; content: string }>,
): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const file of input) {
    let relativePath: string;
    try {
      relativePath = assertManagedTextPath(file.relativePath);
    } catch (error) {
      throw new EnvironmentPackageError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    if (relativePath === 'revision.json') {
      throw new EnvironmentPackageError(
        'Package must not include system metadata file: revision.json',
      );
    }
    if (byPath.has(relativePath)) {
      throw new EnvironmentPackageError(`Duplicate package file path: ${relativePath}`);
    }
    byPath.set(relativePath, file.content);
  }
  return byPath;
}

function assertPackageFileSafety(byPath: Map<string, string>): void {
  for (const [relativePath, content] of byPath) {
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > SPACE_V1_LIMITS.maxFileBytes) {
      throw new EnvironmentPackageError(
        `File exceeds ${SPACE_V1_LIMITS.maxFileBytes} bytes: ${relativePath}`,
      );
    }
    const scan = scanKnowledgeSecrets(content);
    if (scan.status === 'blocked') {
      const finding = scan.findings[0];
      throw new EnvironmentPackageError(
        `Package contains a possible secret (${finding?.ruleId ?? 'unknown'} at ${relativePath}:${finding?.line ?? 1})`,
      );
    }
    if (scan.status === 'quarantined') {
      const finding = scan.findings[0];
      throw new EnvironmentPackageError(
        `Package contains suspicious secret-like content (${finding?.ruleId ?? 'unknown'} at ${relativePath}:${finding?.line ?? 1})`,
      );
    }
  }

  const totalBytes = [...byPath.values()]
    .reduce((sum, content) => sum + Buffer.byteLength(content, 'utf8'), 0);
  if (totalBytes > SPACE_V1_LIMITS.maxObjectBytes) {
    throw new EnvironmentPackageError(
      `Package exceeds ${SPACE_V1_LIMITS.maxObjectBytes} bytes`,
    );
  }
}

function orderedFiles(byPath: Map<string, string>): EnvironmentPackageFile[] {
  return [...byPath.keys()]
    .sort((left, right) => left.localeCompare(right, 'en-US'))
    .map((relativePath) => ({
      relative_path: relativePath,
      content: byPath.get(relativePath)!,
    }));
}

/** Build a portable environment object payload from validated object files. */
export function buildEnvironmentObjectPackage(input: {
  files: ReadonlyArray<{ relativePath: string; content: string }>;
  contentHash: string;
}): BuiltEnvironmentObject {
  const byPath = collectPackageFiles(input.files);
  const entry = byPath.get('SPACE.md');
  if (entry === undefined) {
    throw new EnvironmentPackageError('Environment package must include SPACE.md');
  }

  let document: SpaceDocument;
  try {
    document = parseSpaceDocument(entry);
  } catch (error) {
    throw new EnvironmentPackageError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (document.metadata.kind !== 'environment') {
    throw new EnvironmentPackageError('Package SPACE.md must declare kind: environment');
  }
  if (document.metadata.schema_version !== SPACE_SCHEMA_VERSION) {
    throw new EnvironmentPackageError(
      `Unsupported schema_version: ${document.metadata.schema_version}`,
    );
  }

  byPath.set('SPACE.md', serializeSpaceDocument(document));
  assertPackageFileSafety(byPath);
  const files = orderedFiles(byPath);

  return {
    payload: {
      id: document.metadata.id,
      name: document.metadata.name,
      content_hash: input.contentHash,
      files,
    },
    document,
    contentHash: input.contentHash,
  };
}

export function buildEnvironmentPackage(input: {
  packageKind: EnvironmentPackageKind;
  environment: BuiltEnvironmentObject;
  modules: BuiltKnowledgeModulePackage[];
  exportedAt: string;
}): BuiltEnvironmentPackage {
  if (input.packageKind === ENVIRONMENT_DEFINITION_KIND && input.modules.length > 0) {
    throw new EnvironmentPackageError(
      'Definition-only environment package must not embed module payloads',
    );
  }

  const moduleIds = new Set<string>();
  for (const module of input.modules) {
    if (moduleIds.has(module.package.id)) {
      throw new EnvironmentPackageError(
        `Duplicate module package id: ${module.package.id}`,
      );
    }
    moduleIds.add(module.package.id);
  }

  return {
    package: {
      format_version: ENVIRONMENT_PACKAGE_FORMAT_VERSION,
      package_kind: input.packageKind,
      schema_version: SPACE_SCHEMA_VERSION,
      exported_at: input.exportedAt,
      environment: input.environment.payload,
      modules: input.modules.map((module) => ({
        id: module.package.id,
        name: module.package.name,
        content_hash: module.contentHash,
        files: module.package.files,
      })),
    },
    environment: input.environment,
    modules: input.modules,
  };
}

export function serializeEnvironmentPackage(packageData: EnvironmentPackage): string {
  return `${JSON.stringify(packageData, null, 2)}\n`;
}

function assertNoAbsolutePaths(files: ReadonlyArray<{ relative_path: string }>): void {
  for (const file of files) {
    if (
      path.isAbsolute(file.relative_path)
      || path.win32.isAbsolute(file.relative_path)
      || /^[A-Za-z]:/.test(file.relative_path)
      || file.relative_path.includes('\0')
    ) {
      throw new EnvironmentPackageError(
        `Absolute or unsafe package path is not allowed: ${file.relative_path}`,
      );
    }
  }
}

async function stageAndHashObject(
  files: ReadonlyArray<KnowledgeModulePackageFile>,
  stagingRoot: string,
  expectedKind: 'environment' | 'knowledge',
  expectedId: string,
  expectedHash: string,
): Promise<{ document: SpaceDocument; contentHash: string }> {
  await fs.mkdir(stagingRoot, { recursive: true });
  for (const file of files) {
    const targetPath = path.join(stagingRoot, ...file.relative_path.split('/'));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, 'utf8');
  }

  let loaded;
  try {
    loaded = await loadSpaceObject(stagingRoot);
  } catch (error) {
    if (error instanceof ObjectRootError || error instanceof Error) {
      throw new EnvironmentPackageError(error.message, { cause: error });
    }
    throw error;
  }

  if (loaded.document.metadata.kind !== expectedKind) {
    throw new EnvironmentPackageError(
      `Imported package object is not a ${expectedKind} profile`,
    );
  }
  if (loaded.document.metadata.id !== expectedId) {
    throw new EnvironmentPackageError(
      'Imported SPACE.md stable id does not match package id',
    );
  }
  if (loaded.contentHash !== expectedHash) {
    throw new EnvironmentPackageError(
      `Package content hash mismatch: expected ${expectedHash}, computed ${loaded.contentHash}`,
    );
  }

  return {
    document: loaded.document,
    contentHash: loaded.contentHash,
  };
}

/**
 * Parse and fully validate a portable environment package.
 * Stages each embedded object under stagingRoot for path sandbox + hash checks.
 */
export async function loadAndValidateEnvironmentPackage(
  packagePath: string,
  stagingRoot: string,
): Promise<BuiltEnvironmentPackage> {
  let rawText: string;
  try {
    rawText = await fs.readFile(packagePath, 'utf8');
  } catch (error) {
    throw new EnvironmentPackageError(
      `Unable to read environment package: ${packagePath}`,
      { cause: error },
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawText);
  } catch (error) {
    throw new EnvironmentPackageError('Environment package is not valid JSON', {
      cause: error,
    });
  }

  let packageData: EnvironmentPackage;
  try {
    packageData = environmentPackageSchema.parse(decoded);
  } catch (error) {
    throw new EnvironmentPackageError(
      error instanceof Error
        ? `Invalid environment package: ${error.message}`
        : 'Invalid environment package',
      { cause: error },
    );
  }

  assertNoAbsolutePaths(packageData.environment.files);
  for (const module of packageData.modules) {
    assertNoAbsolutePaths(module.files);
  }

  if (
    packageData.package_kind === ENVIRONMENT_DEFINITION_KIND
    && packageData.modules.length > 0
  ) {
    throw new EnvironmentPackageError(
      'Definition-only environment package must not embed module payloads',
    );
  }

  const envStaging = path.join(stagingRoot, 'environment');
  const builtEnvironment = buildEnvironmentObjectPackage({
    files: packageData.environment.files.map((file) => ({
      relativePath: file.relative_path,
      content: file.content,
    })),
    contentHash: packageData.environment.content_hash,
  });
  if (builtEnvironment.payload.id !== packageData.environment.id) {
    throw new EnvironmentPackageError(
      `Environment id does not match SPACE.md stable id: package=${packageData.environment.id} space=${builtEnvironment.payload.id}`,
    );
  }

  const envLoaded = await stageAndHashObject(
    builtEnvironment.payload.files,
    envStaging,
    'environment',
    packageData.environment.id,
    packageData.environment.content_hash,
  );

  const modules: BuiltKnowledgeModulePackage[] = [];
  for (const [index, modulePayload] of packageData.modules.entries()) {
    try {
      const built = buildKnowledgeModulePackage({
        files: modulePayload.files.map((file) => ({
          relativePath: file.relative_path,
          content: file.content,
        })),
        contentHash: modulePayload.content_hash,
        exportedAt: packageData.exported_at,
      });
      if (built.package.id !== modulePayload.id) {
        throw new EnvironmentPackageError(
          `Module id does not match SPACE.md stable id: package=${modulePayload.id} space=${built.package.id}`,
        );
      }
      const moduleStaging = path.join(stagingRoot, `module-${index}`);
      const loaded = await stageAndHashObject(
        built.package.files,
        moduleStaging,
        'knowledge',
        modulePayload.id,
        modulePayload.content_hash,
      );
      modules.push({
        package: {
          ...built.package,
          content_hash: loaded.contentHash,
          name: loaded.document.metadata.name,
        },
        document: loaded.document,
        contentHash: loaded.contentHash,
      });
    } catch (error) {
      if (error instanceof ModulePackageError || error instanceof EnvironmentPackageError) {
        throw new EnvironmentPackageError(error.message, { cause: error });
      }
      throw error;
    }
  }

  // Self-contained packages may omit unresolved module IDs; definition-only embeds none.
  if (packageData.package_kind === ENVIRONMENT_BUNDLE_KIND) {
    const embedded = new Set(modules.map((module) => module.package.id));
    const referenced = [
      ...envLoaded.document.metadata.kind === 'environment'
        ? envLoaded.document.metadata.modules.always
        : [],
      ...envLoaded.document.metadata.kind === 'environment'
        ? envLoaded.document.metadata.modules.on_demand
        : [],
    ];
    // Extra embedded modules that are not referenced are rejected to keep packages tight.
    for (const moduleId of embedded) {
      if (!referenced.includes(moduleId)) {
        throw new EnvironmentPackageError(
          `Embedded module is not referenced by the environment: ${moduleId}`,
        );
      }
    }
  }

  return {
    package: {
      ...packageData,
      environment: {
        ...builtEnvironment.payload,
        content_hash: envLoaded.contentHash,
        name: envLoaded.document.metadata.name,
      },
      modules: modules.map((module) => ({
        id: module.package.id,
        name: module.package.name,
        content_hash: module.contentHash,
        files: module.package.files,
      })),
    },
    environment: {
      payload: {
        ...builtEnvironment.payload,
        content_hash: envLoaded.contentHash,
        name: envLoaded.document.metadata.name,
      },
      document: envLoaded.document,
      contentHash: envLoaded.contentHash,
    },
    modules,
  };
}

export function rewriteEnvironmentStableId(
  built: BuiltEnvironmentObject,
  newId: string,
): BuiltEnvironmentObject {
  if (built.document.metadata.kind !== 'environment') {
    throw new EnvironmentPackageError('Only environment profiles can rewrite stable ids');
  }
  const rewrittenDocument: SpaceDocument = {
    metadata: {
      ...built.document.metadata,
      id: newId,
    },
    body: built.document.body,
  };
  const files = built.payload.files.map((file) =>
    file.relative_path === 'SPACE.md'
      ? { relative_path: 'SPACE.md', content: serializeSpaceDocument(rewrittenDocument) }
      : file
  );
  return buildEnvironmentObjectPackage({
    files: files.map((file) => ({
      relativePath: file.relative_path,
      content: file.content,
    })),
    contentHash: built.contentHash,
  });
}

export function rewriteEnvironmentModuleAssociations(
  built: BuiltEnvironmentObject,
  idMap: ReadonlyMap<string, string>,
): BuiltEnvironmentObject {
  if (built.document.metadata.kind !== 'environment') {
    throw new EnvironmentPackageError('Only environment profiles can rewrite module associations');
  }
  if (idMap.size === 0) {
    return built;
  }
  const mapId = (id: string) => idMap.get(id) ?? id;
  const rewrittenDocument: SpaceDocument = {
    metadata: {
      ...built.document.metadata,
      modules: {
        always: built.document.metadata.modules.always.map(mapId),
        on_demand: built.document.metadata.modules.on_demand.map(mapId),
      },
    },
    body: built.document.body,
  };
  const files = built.payload.files.map((file) =>
    file.relative_path === 'SPACE.md'
      ? { relative_path: 'SPACE.md', content: serializeSpaceDocument(rewrittenDocument) }
      : file
  );
  // Caller recomputes the authoritative content hash after staging.
  return buildEnvironmentObjectPackage({
    files: files.map((file) => ({
      relativePath: file.relative_path,
      content: file.content,
    })),
    contentHash: built.contentHash,
  });
}

export function environmentReferencedModuleIds(document: SpaceDocument): {
  always: string[];
  onDemand: string[];
  all: string[];
} {
  if (document.metadata.kind !== 'environment') {
    throw new EnvironmentPackageError('Document is not an environment profile');
  }
  const always = [...document.metadata.modules.always];
  const onDemand = [...document.metadata.modules.on_demand];
  return {
    always,
    onDemand,
    all: [...always, ...onDemand],
  };
}
