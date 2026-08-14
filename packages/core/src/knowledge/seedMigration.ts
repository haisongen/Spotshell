import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeRepository } from './knowledgeRepository.js';
import type {
  ModuleImportConflictResolution,
  ModuleImportResult,
  TrashRestoreResult,
} from './knowledgeRepository.js';
import {
  getOfficialSeedById,
  getOfficialSeedByKey,
  isOfficialSeedId,
  OFFICIAL_SEED_MODULES,
  serializeOfficialSeedPackage,
  type OfficialSeedKey,
  type OfficialSeedModuleDefinition,
} from './seedModules.js';

export const SEED_MIGRATION_MARKER_VERSION = 1 as const;
export const SEED_MIGRATION_MARKER_FILE = 'seed-migration.json';

export interface SeedMigrationMarker {
  version: typeof SEED_MIGRATION_MARKER_VERSION;
  completedAt: string;
  seedIds: string[];
}

export type SeedModulePresence =
  | 'present-identical'
  | 'present-divergent'
  | 'in-trash'
  | 'missing';

export interface SeedModuleStatus {
  key: OfficialSeedKey;
  id: string;
  name: string;
  presence: SeedModulePresence;
  localRevision?: number;
  localContentHash?: string;
  officialContentHash: string;
}

export interface SeedEnsureAction {
  key: OfficialSeedKey;
  id: string;
  action: 'created' | 'skipped-exists' | 'skipped-in-trash' | 'already-marked';
  contentHash?: string;
  revision?: number;
}

export interface SeedEnsureResult {
  alreadyCompleted: boolean;
  markerWritten: boolean;
  actions: SeedEnsureAction[];
  createdIds: string[];
}

export type SeedRestorePreview =
  | {
    status: 'in-trash';
    seed: Pick<OfficialSeedModuleDefinition, 'key' | 'id' | 'name'>;
  }
  | {
    status: 'missing';
    seed: Pick<OfficialSeedModuleDefinition, 'key' | 'id' | 'name'>;
    officialContentHash: string;
  }
  | {
    status: 'identical';
    seed: Pick<OfficialSeedModuleDefinition, 'key' | 'id' | 'name'>;
    localRevision: number;
    contentHash: string;
  }
  | {
    status: 'conflict';
    seed: Pick<OfficialSeedModuleDefinition, 'key' | 'id' | 'name'>;
    localRevision: number;
    localContentHash: string;
    officialContentHash: string;
  };

export type SeedRestoreResult =
  | {
    status: 'restored-from-trash';
    id: string;
    key: OfficialSeedKey;
    trash: TrashRestoreResult;
  }
  | {
    status: 'identical';
    id: string;
    key: OfficialSeedKey;
    revision: number;
    contentHash: string;
  }
  | (ModuleImportResult & {
    key: OfficialSeedKey;
  });

function seedSummary(seed: OfficialSeedModuleDefinition): Pick<
  OfficialSeedModuleDefinition,
  'key' | 'id' | 'name'
> {
  return { key: seed.key, id: seed.id, name: seed.name };
}

export function seedMigrationMarkerPath(rootPath: string): string {
  return path.join(rootPath, SEED_MIGRATION_MARKER_FILE);
}

export async function readSeedMigrationMarker(
  rootPath: string,
): Promise<SeedMigrationMarker | undefined> {
  const markerPath = seedMigrationMarkerPath(rootPath);
  try {
    const raw = await fs.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SeedMigrationMarker>;
    if (
      parsed.version !== SEED_MIGRATION_MARKER_VERSION
      || typeof parsed.completedAt !== 'string'
      || !Array.isArray(parsed.seedIds)
    ) {
      return undefined;
    }
    const seedIds = parsed.seedIds.filter((id): id is string => typeof id === 'string');
    return {
      version: SEED_MIGRATION_MARKER_VERSION,
      completedAt: parsed.completedAt,
      seedIds,
    };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    return undefined;
  }
}

async function writeSeedMigrationMarker(
  rootPath: string,
  marker: SeedMigrationMarker,
): Promise<void> {
  const markerPath = seedMigrationMarkerPath(rootPath);
  await fs.mkdir(rootPath, { recursive: true });
  const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(marker, null, 2)}\n`;
  try {
    await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporaryPath, markerPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeTemporarySeedPackage(
  rootPath: string,
  seed: OfficialSeedModuleDefinition,
): Promise<string> {
  const packageDir = path.join(rootPath, `.tmp-seed-${randomUUID()}`);
  await fs.mkdir(packageDir, { recursive: true });
  const packagePath = path.join(packageDir, `${seed.key}.spotshell-module.json`);
  const serialized = serializeOfficialSeedPackage(seed);
  await fs.writeFile(packagePath, serialized.text, 'utf8');
  return packagePath;
}

async function withTemporarySeedPackage<T>(
  rootPath: string,
  seed: OfficialSeedModuleDefinition,
  operation: (packagePath: string) => Promise<T>,
): Promise<T> {
  const packagePath = await writeTemporarySeedPackage(rootPath, seed);
  try {
    return await operation(packagePath);
  } finally {
    await fs.rm(path.dirname(packagePath), { recursive: true, force: true });
  }
}

/**
 * One-time initialization of the seven official seed modules (ADR-051/052).
 * Idempotent: after the marker is written, upgrades never recreate or overwrite seeds.
 * While the marker is absent, only missing seeds are created (partial-retry safe).
 */
export async function ensureOfficialSeedModules(options: {
  repository: KnowledgeRepository;
  rootPath: string;
  /**
   * Called only when a seed module is newly created.
   * Desktop uses this to grant global on-demand authorization.
   */
  onCreated?: (seed: OfficialSeedModuleDefinition, result: ModuleImportResult) => void | Promise<void>;
  now?: Date;
}): Promise<SeedEnsureResult> {
  const { repository, rootPath, onCreated } = options;
  const existingMarker = await readSeedMigrationMarker(rootPath);
  if (existingMarker) {
    return {
      alreadyCompleted: true,
      markerWritten: false,
      actions: OFFICIAL_SEED_MODULES.map((seed) => ({
        key: seed.key,
        id: seed.id,
        action: 'already-marked',
      })),
      createdIds: [],
    };
  }

  const trashIds = new Set((await repository.listTrash()).map((entry) => entry.id));
  const actions: SeedEnsureAction[] = [];
  const createdIds: string[] = [];

  for (const seed of OFFICIAL_SEED_MODULES) {
    if (trashIds.has(seed.id)) {
      actions.push({ key: seed.key, id: seed.id, action: 'skipped-in-trash' });
      continue;
    }

    const published = await repository.resolvePublishedObject(seed.id);
    if (published) {
      actions.push({
        key: seed.key,
        id: seed.id,
        action: 'skipped-exists',
        contentHash: published.contentHash,
        revision: published.revision,
      });
      continue;
    }

    // Draft-only or incomplete path: import still fails if the object directory exists.
    const modules = await repository.listModules();
    if (modules.some((module) => module.id === seed.id)) {
      actions.push({ key: seed.key, id: seed.id, action: 'skipped-exists' });
      continue;
    }

    const imported = await withTemporarySeedPackage(rootPath, seed, (packagePath) =>
      repository.importKnowledgeModule(packagePath),
    );
    if (imported.status !== 'created') {
      // Identical after race, or unexpected — treat as exists.
      actions.push({
        key: seed.key,
        id: seed.id,
        action: 'skipped-exists',
        contentHash: imported.contentHash,
        revision: imported.revision,
      });
      continue;
    }

    await onCreated?.(seed, imported);
    createdIds.push(seed.id);
    actions.push({
      key: seed.key,
      id: seed.id,
      action: 'created',
      contentHash: imported.contentHash,
      revision: imported.revision,
    });
  }

  const marker: SeedMigrationMarker = {
    version: SEED_MIGRATION_MARKER_VERSION,
    completedAt: (options.now ?? new Date()).toISOString(),
    seedIds: OFFICIAL_SEED_MODULES.map((seed) => seed.id),
  };
  await writeSeedMigrationMarker(rootPath, marker);

  return {
    alreadyCompleted: false,
    markerWritten: true,
    actions,
    createdIds,
  };
}

export async function listOfficialSeedStatuses(options: {
  repository: KnowledgeRepository;
  rootPath: string;
}): Promise<SeedModuleStatus[]> {
  const { repository } = options;
  const trashIds = new Set((await repository.listTrash()).map((entry) => entry.id));
  const statuses: SeedModuleStatus[] = [];

  for (const seed of OFFICIAL_SEED_MODULES) {
    const officialContentHash = serializeOfficialSeedPackage(seed).contentHash;
    if (trashIds.has(seed.id)) {
      statuses.push({
        key: seed.key,
        id: seed.id,
        name: seed.name,
        presence: 'in-trash',
        officialContentHash,
      });
      continue;
    }

    const published = await repository.resolvePublishedObject(seed.id);
    if (!published) {
      const modules = await repository.listModules();
      if (modules.some((module) => module.id === seed.id)) {
        statuses.push({
          key: seed.key,
          id: seed.id,
          name: seed.name,
          presence: 'present-divergent',
          officialContentHash,
        });
        continue;
      }
      statuses.push({
        key: seed.key,
        id: seed.id,
        name: seed.name,
        presence: 'missing',
        officialContentHash,
      });
      continue;
    }

    statuses.push({
      key: seed.key,
      id: seed.id,
      name: seed.name,
      presence: published.contentHash === officialContentHash
        ? 'present-identical'
        : 'present-divergent',
      localRevision: published.revision,
      localContentHash: published.contentHash,
      officialContentHash,
    });
  }

  return statuses;
}

export async function previewRestoreOfficialSeed(options: {
  repository: KnowledgeRepository;
  rootPath: string;
  seedKey: string;
}): Promise<SeedRestorePreview> {
  const seed = getOfficialSeedByKey(options.seedKey);
  if (!seed) throw new Error(`Unknown official seed key: ${options.seedKey}`);

  const trash = await options.repository.listTrash();
  if (trash.some((entry) => entry.id === seed.id)) {
    return { status: 'in-trash', seed: seedSummary(seed) };
  }

  const published = await options.repository.resolvePublishedObject(seed.id);
  const officialContentHash = serializeOfficialSeedPackage(seed).contentHash;
  if (!published) {
    const modules = await options.repository.listModules();
    if (modules.some((module) => module.id === seed.id)) {
      return {
        status: 'conflict',
        seed: seedSummary(seed),
        localRevision: 0,
        localContentHash: 'draft-only',
        officialContentHash,
      };
    }
    return {
      status: 'missing',
      seed: seedSummary(seed),
      officialContentHash,
    };
  }

  if (published.contentHash === officialContentHash) {
    return {
      status: 'identical',
      seed: seedSummary(seed),
      localRevision: published.revision,
      contentHash: published.contentHash,
    };
  }

  return {
    status: 'conflict',
    seed: seedSummary(seed),
    localRevision: published.revision,
    localContentHash: published.contentHash,
    officialContentHash,
  };
}

/**
 * Restore one official seed.
 * Prefers trash restore; otherwise imports official package with explicit conflict resolution.
 */
export async function restoreOfficialSeed(options: {
  repository: KnowledgeRepository;
  rootPath: string;
  seedKey: string;
  conflictResolution?: ModuleImportConflictResolution;
  /**
   * Called after a successful create/update/trash-restore when the caller wants
   * to grant or re-grant global on-demand authorization. Never called for keep-local.
   */
  onRestored?: (seed: OfficialSeedModuleDefinition, id: string) => void | Promise<void>;
}): Promise<SeedRestoreResult> {
  const seed = getOfficialSeedByKey(options.seedKey);
  if (!seed) throw new Error(`Unknown official seed key: ${options.seedKey}`);

  const preview = await previewRestoreOfficialSeed(options);
  if (preview.status === 'in-trash') {
    const trash = await options.repository.restoreFromTrash(seed.id);
    await options.onRestored?.(seed, seed.id);
    return {
      status: 'restored-from-trash',
      id: seed.id,
      key: seed.key,
      trash,
    };
  }

  if (preview.status === 'identical') {
    return {
      status: 'identical',
      id: seed.id,
      key: seed.key,
      revision: preview.localRevision,
      contentHash: preview.contentHash,
    };
  }

  if (preview.status === 'conflict' && !options.conflictResolution) {
    throw new Error(
      'Seed restore conflict requires an explicit resolution: keep-local, use-imported, or import-as-copy',
    );
  }

  const imported = await withTemporarySeedPackage(options.rootPath, seed, (packagePath) =>
    options.repository.importKnowledgeModule(packagePath, options.conflictResolution),
  );

  const shouldAuthorize = imported.status === 'created'
    || imported.status === 'updated'
    || imported.status === 'copied';
  if (shouldAuthorize) {
    await options.onRestored?.(seed, imported.id);
  }

  return { ...imported, key: seed.key };
}

export async function restoreAllOfficialSeeds(options: {
  repository: KnowledgeRepository;
  rootPath: string;
  /**
   * When a seed is present-but-divergent, skip it unless a default conflict resolution is set.
   * Default: skip conflicts so bulk restore never silently overwrites user edits.
   */
  conflictResolution?: ModuleImportConflictResolution;
  onRestored?: (seed: OfficialSeedModuleDefinition, id: string) => void | Promise<void>;
}): Promise<SeedRestoreResult[]> {
  const results: SeedRestoreResult[] = [];
  for (const seed of OFFICIAL_SEED_MODULES) {
    const preview = await previewRestoreOfficialSeed({
      repository: options.repository,
      rootPath: options.rootPath,
      seedKey: seed.key,
    });
    if (preview.status === 'conflict' && !options.conflictResolution) {
      continue;
    }
    if (preview.status === 'identical') {
      results.push({
        status: 'identical',
        id: seed.id,
        key: seed.key,
        revision: preview.localRevision,
        contentHash: preview.contentHash,
      });
      continue;
    }
    results.push(await restoreOfficialSeed({
      repository: options.repository,
      rootPath: options.rootPath,
      seedKey: seed.key,
      conflictResolution: options.conflictResolution,
      onRestored: options.onRestored,
    }));
  }
  return results;
}

export { getOfficialSeedById, getOfficialSeedByKey, isOfficialSeedId, OFFICIAL_SEED_MODULES };

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  if (error === null || typeof error !== 'object') return false
  return 'code' in error && (error as NodeJS.ErrnoException).code === code
}
