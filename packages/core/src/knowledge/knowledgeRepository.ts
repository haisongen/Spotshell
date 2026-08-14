import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { SPACE_SCHEMA_VERSION, SPACE_V1_LIMITS } from './limits.js';
import {
  assertManagedTextPath,
  decodeManagedTextBytes,
  isGuidanceEligiblePath,
  normalizeRelativePath,
  ObjectRootError,
  SafeObjectRoot,
} from './safeObjectRoot.js';
import { scanKnowledgeSecrets } from './secretScanner.js';
import {
  hasSubstantiveSpaceContent,
  parseSpaceDocument,
  serializeSpaceDocument,
  spaceDocumentFromForm,
  toSpaceForm,
  type EnvironmentSpaceMetadata,
  type KnowledgeSpaceMetadata,
  type SpaceDocument,
} from './spaceDocument.js';
import {
  buildKnowledgeModulePackage,
  loadAndValidateKnowledgeModulePackage,
  ModulePackageError,
  rewritePackageStableId,
  serializeKnowledgeModulePackage,
  type BuiltKnowledgeModulePackage,
} from './modulePackage.js';
import {
  buildEnvironmentObjectPackage,
  buildEnvironmentPackage,
  ENVIRONMENT_BUNDLE_KIND,
  ENVIRONMENT_DEFINITION_KIND,
  environmentReferencedModuleIds,
  EnvironmentPackageError,
  loadAndValidateEnvironmentPackage,
  rewriteEnvironmentModuleAssociations,
  rewriteEnvironmentStableId,
  serializeEnvironmentPackage,
  type BuiltEnvironmentObject,
  type BuiltEnvironmentPackage,
  type EnvironmentPackageKind,
} from './environmentPackage.js';
import { loadSpaceObject } from './spaceObject.js';
import { buildUnifiedDiff } from './unifiedDiff.js';
import {
  annotateRevisionHistoryEntry,
  assertCleanupAllowed,
  assertEnoughDiskSpace,
  buildRevisionComparison,
  DEFAULT_MIN_FREE_DISK_BYTES,
  normalizeRevisionOrigin,
  exclusiveBytesForRevision,
  planRevisionCleanup,
  publishOrigin,
  proposalOrigin,
  restoreOrigin,
  type BlobReference,
  type RevisionComparison,
  type RevisionCleanupPreview,
  type RevisionFileSnapshot,
  type RevisionHistoryEntry,
  type RevisionProtectionInput,
} from './revisionHistory.js';
import {
  detectExternalContentDiff,
  externalOrigin,
  filterWorkingContentPaths,
  isEditorTemporaryPath,
  type ExternalFileDiff,
} from './externalEdits.js';
import {
  assertCanMoveToTrash,
  buildTrashRecord,
  daysRemaining,
  emptyReferenceSnapshot,
  planEnvironmentDelete,
  planModuleDelete,
  planPermanentDelete,
  planRestoreAssociations,
  selectExpiredTrashEntries,
  type EnvironmentDeletePreview,
  type EnvironmentHostBinding,
  type ModuleDeletePreview,
  type ModuleReferenceByEnvironment,
  type PermanentDeletePreview,
  type RestoreAssociationResult,
  type TrashObjectKind,
  type TrashRecord,
  type TrashReferenceSnapshot,
} from './trash.js';

export type {
  RevisionComparison,
  RevisionCleanupPreview,
  RevisionFileDiff,
  RevisionFileSnapshot,
  RevisionHistoryEntry,
  RevisionProtectionInput,
  RevisionProtectionReason,
} from './revisionHistory.js';

export type {
  DeleteBlocker,
  DeleteBlockerCode,
  EnvironmentDeletePreview,
  EnvironmentHostBinding,
  ModuleDeletePreview,
  ModuleReferenceByEnvironment,
  PermanentDeletePreview,
  RestoreAssociationResult,
  RestoreAssociationStatus,
  TrashObjectKind,
  TrashRecord,
  TrashReferenceSnapshot,
} from './trash.js';

export {
  DEFAULT_TRASH_RETENTION_DAYS,
  computeExpiresAt,
  daysRemaining,
  isExpired,
} from './trash.js';

export interface RevisionCleanupResult {
  objectId: string;
  removedRevisions: number[];
  freedBytes: number;
}

export interface TrashEntrySummary {
  id: string;
  kind: TrashObjectKind;
  name: string;
  deletedAt: string;
  expiresAt: string;
  latestRevision?: number;
  contentHash?: string;
  daysRemaining: number;
}

export interface TrashEntryDetail extends TrashEntrySummary {
  referenceSnapshot: TrashReferenceSnapshot;
}

export interface TrashMoveResult extends TrashEntryDetail {}

export interface TrashRestoreResult {
  id: string;
  kind: TrashObjectKind;
  name: string;
  associationResults: RestoreAssociationResult[];
}

export interface TrashPurgeResult {
  purgedIds: string[];
  skippedIds: string[];
}

export interface TrashRepairResult {
  completedMoves: string[];
}

export interface KnowledgeRepositoryOptions {
  /**
   * Inject free-disk probe for tests or constrained environments.
   * When omitted, Node's `fs.statfs` is used when available.
   */
  getFreeDiskBytes?: (rootPath: string) => Promise<number>;
  /** Minimum free bytes required before creating a valid revision. */
  minFreeBytes?: number;
}

/** Disk working-tree status relative to the last app-known baseline (ADR-057). */
export type ExternalChangeState = 'clean' | 'pending' | 'invalid';

export interface ExternalChangeStatus {
  id: string;
  kind: 'environment' | 'knowledge';
  name: string;
  status: ExternalChangeState;
  hasPendingExternalChanges: boolean;
  latestRevision?: number;
  latestContentHash?: string;
  workingContentHash: string;
  files: ExternalFileDiff[];
  validationErrors: string[];
  detectedAt: string;
}

export interface ExternalChangePreview extends ExternalChangeStatus {
  canAdopt: boolean;
}

interface ExternalBaselineRecord {
  files: Record<string, string>;
  capturedAt: string;
}

const storedRevisionSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  source: z.string(),
  origin: z.string().optional(),
  files: z.record(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
}).strict();

const trashReferenceSnapshotSchema = z.object({
  referencedBy: z.array(z.object({
    environmentId: z.string().uuid(),
    environmentName: z.string(),
    mode: z.enum(['always', 'on_demand']),
  }).strict()),
  associations: z.object({
    always: z.array(z.string().uuid()),
    onDemand: z.array(z.string().uuid()),
  }).strict(),
  boundHosts: z.array(z.object({
    hostId: z.string().min(1),
    hostName: z.string(),
  }).strict()),
}).strict();

const trashRecordSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['environment', 'knowledge']),
  name: z.string(),
  deletedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  latestRevision: z.number().int().positive().optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  referenceSnapshot: trashReferenceSnapshotSchema,
}).strict();

const manifestSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['environment', 'knowledge']).optional(),
  createdAt: z.string().datetime(),
  latestRevision: z.number().int().positive().optional(),
  draftSummary: z.object({
    name: z.string(),
    description: z.string(),
    whenToUse: z.string().optional(),
    tags: z.array(z.string()),
  }).strict(),
}).strict();

const draftRecordSchema = z.object({
  source: z.string(),
  savedAt: z.string().datetime(),
  form: z.object({
    name: z.string(),
    description: z.string(),
    whenToUse: z.string(),
    whenNotToUse: z.string().optional(),
    tags: z.array(z.string()),
    beforeGuidance: z.string(),
    inlineGuidance: z.string().optional(),
    afterGuidance: z.string(),
  }).strict().or(z.object({
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    always: z.array(z.string().uuid()),
    onDemand: z.array(z.string().uuid()),
    body: z.string(),
  }).strict()).optional(),
}).strict();

export interface CreateKnowledgeDraftInput {
  name: string;
}

export interface CreateEnvironmentDraftInput {
  name: string;
}

export interface EnvironmentFormDraft {
  name: string;
  description: string;
  tags: string[];
  always: string[];
  onDemand: string[];
  body: string;
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  draftSavedAt: string;
  latestRevision?: number;
  latestContentHash?: string;
}

export interface EnvironmentDetail extends EnvironmentSummary {
  source: string;
  form?: EnvironmentFormDraft;
  associations: {
    always: EnvironmentModuleDependency[];
    onDemand: EnvironmentModuleDependency[];
  };
  draftValidationError?: string;
}

export interface EnvironmentModuleDependency {
  id: string;
  name?: string;
  status: 'resolved' | 'unresolved';
}

export interface PublishedEnvironmentSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  always: string[];
  onDemand: string[];
  revision: number;
  contentHash: string;
}

export interface KnowledgeModuleFormDraft {
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse?: string;
  tags: string[];
  beforeGuidance: string;
  inlineGuidance?: string;
  afterGuidance: string;
}

export interface KnowledgeModuleSummary {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  tags: string[];
  draftSavedAt: string;
  latestRevision?: number;
  latestContentHash?: string;
}

export interface PublishedKnowledgeModuleSummary {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  tags: string[];
  revision: number;
  contentHash: string;
}

export interface KnowledgeModuleDetail extends KnowledgeModuleSummary {
  source: string;
  form?: KnowledgeModuleFormDraft;
  draftValidationError?: string;
}

export interface SpaceRevision {
  id: string;
  revision: number;
  contentHash: string;
  createdAt: string;
  /** Full SPACE.md source snapshot (legacy field name). */
  source: string;
  /** How this revision was produced (publish, restore:N, import, …). */
  origin?: string;
  /** Per-file content hashes for content-addressed storage and cleanup GC. */
  files?: Record<string, string>;
}

export type KnowledgeRevision = SpaceRevision;

/** Active published revision root used by the read-only knowledge harness. */
export interface PublishedObjectRoot {
  id: string;
  name: string;
  kind: 'environment' | 'knowledge';
  revision: number;
  contentHash: string;
  rootPath: string;
  guidanceFiles: string[];
  alwaysModuleIds: string[];
}

export interface ManagedObjectFileOrigin {
  sourcePath: string;
  originalName: string;
  importedAt: string;
  contentHash: string;
}

export interface ManagedObjectFileSummary {
  relativePath: string;
  sizeBytes: number;
  role: 'reference' | 'guidance';
  guidanceEligible: boolean;
  origin?: ManagedObjectFileOrigin;
  secretStatus: 'clean' | 'blocked' | 'quarantined';
}

export interface ManagedObjectFilesDetail {
  id: string;
  kind: 'environment' | 'knowledge';
  files: ManagedObjectFileSummary[];
  guidanceFiles: string[];
}

export interface ManagedFileContent {
  relativePath: string;
  content: string;
  origin?: ManagedObjectFileOrigin;
}

export interface CreateManagedTextFileInput {
  relativePath: string;
  content?: string;
}

export interface ImportManagedTextFileInput {
  relativePath: string;
  absoluteSourcePath: string;
}

export interface ExportedKnowledgeModulePackage {
  id: string;
  name: string;
  contentHash: string;
  packagePath: string;
}

export interface ModuleImportLocalSnapshot {
  id: string;
  name: string;
  revision: number;
  contentHash: string;
}

export interface ModuleImportIncomingSnapshot {
  id: string;
  name: string;
  contentHash: string;
  packagePath: string;
}

export type ModuleImportPreview =
  | {
    status: 'create';
    incoming: ModuleImportIncomingSnapshot;
  }
  | {
    status: 'identical';
    local: ModuleImportLocalSnapshot;
    incoming: ModuleImportIncomingSnapshot;
  }
  | {
    status: 'conflict';
    local: ModuleImportLocalSnapshot;
    incoming: ModuleImportIncomingSnapshot;
  };

export type ModuleImportConflictResolution =
  | 'keep-local'
  | 'use-imported'
  | 'import-as-copy';

export type ModuleImportResult =
  | {
    status: 'created';
    id: string;
    revision: number;
    contentHash: string;
  }
  | {
    status: 'identical';
    id: string;
    revision: number;
    contentHash: string;
  }
  | {
    status: 'kept-local';
    id: string;
    revision: number;
    contentHash: string;
  }
  | {
    status: 'updated';
    id: string;
    revision: number;
    contentHash: string;
  }
  | {
    status: 'copied';
    id: string;
    sourceId: string;
    revision: number;
    contentHash: string;
  };

export type EnvironmentExportMode = 'self-contained' | 'definition-only';

export interface EnvironmentExportModulePreview {
  id: string;
  name?: string;
  association: 'always' | 'on_demand';
  status: 'resolved' | 'unresolved';
  revision?: number;
  contentHash?: string;
}

export interface EnvironmentExportPreview {
  environment: {
    id: string;
    name: string;
    revision: number;
    contentHash: string;
  };
  modules: EnvironmentExportModulePreview[];
  modeDefault: EnvironmentExportMode;
}

export interface ExportedEnvironmentPackage {
  id: string;
  name: string;
  contentHash: string;
  packagePath: string;
  mode: EnvironmentExportMode;
  moduleCount: number;
  unresolvedModuleIds: string[];
}

export interface EnvironmentImportObjectSnapshot {
  id: string;
  name: string;
  contentHash: string;
  revision?: number;
}

export type EnvironmentImportObjectStatus =
  | 'create'
  | 'identical'
  | 'conflict'
  | 'missing';

export interface EnvironmentImportModulePreview {
  id: string;
  association?: 'always' | 'on_demand';
  status: EnvironmentImportObjectStatus;
  local?: EnvironmentImportObjectSnapshot;
  incoming?: EnvironmentImportObjectSnapshot;
}

export interface EnvironmentImportPreview {
  packageKind: 'environment-bundle' | 'environment-definition';
  packagePath: string;
  environment: {
    status: Exclude<EnvironmentImportObjectStatus, 'missing'>;
    local?: EnvironmentImportObjectSnapshot;
    incoming: EnvironmentImportObjectSnapshot;
  };
  modules: EnvironmentImportModulePreview[];
  unresolvedModuleIds: string[];
}

export interface EnvironmentImportResolutions {
  environmentResolution?: ModuleImportConflictResolution;
  moduleResolutions?: Record<string, ModuleImportConflictResolution>;
}

export interface EnvironmentImportResult {
  environment: ModuleImportResult;
  modules: Array<ModuleImportResult & { sourceId?: string }>;
  unresolvedModuleIds: string[];
  mode: EnvironmentExportMode;
}

export interface SourceUpdatePreview {
  relativePath: string;
  sourcePath: string;
  current: string;
  incoming: string;
  unifiedDiff: string;
  changed: boolean;
}

interface FileOriginsRecord {
  [relativePath: string]: ManagedObjectFileOrigin;
}

interface StoredManifest {
  id: string;
  kind?: 'environment' | 'knowledge';
  createdAt: string;
  latestRevision?: number;
  draftSummary: DraftSummary;
}

interface DraftSummary {
  name: string;
  description: string;
  whenToUse?: string;
  tags: string[];
}

interface DraftRecord {
  source: string;
  savedAt: string;
  form?: KnowledgeModuleFormDraft | EnvironmentFormDraft;
}

interface EnvironmentImportObjectStateSnapshot {
  manifest: StoredManifest;
  draft: DraftRecord;
  fileOrigins?: string;
  draftFilesBackup?: string;
}

type EnvironmentImportRollbackEntry =
  | { kind: 'created'; id: string }
  | {
    kind: 'revision';
    id: string;
    revision: number;
    snapshot: EnvironmentImportObjectStateSnapshot;
  };

export class KnowledgeRepository {
  private operation = Promise.resolve();
  private readonly minFreeBytes: number;
  private readonly getFreeDiskBytes?: (rootPath: string) => Promise<number>;

  constructor(
    private readonly rootPath: string,
    options: KnowledgeRepositoryOptions = {},
  ) {
    this.minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_DISK_BYTES;
    this.getFreeDiskBytes = options.getFreeDiskBytes;
  }

  createEnvironmentDraft(input: CreateEnvironmentDraftInput): Promise<EnvironmentDetail> {
    return this.runExclusive(async () => {
      const name = input.name.trim();
      if (!name) throw new Error('Environment name is required');
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const objectPath = this.objectPath(id);
      const temporaryPath = path.join(this.rootPath, `.tmp-${randomUUID()}`);
      await fs.mkdir(path.join(temporaryPath, 'revisions'), { recursive: true });
      const metadata: EnvironmentSpaceMetadata = {
        schema_version: SPACE_SCHEMA_VERSION,
        id,
        kind: 'environment',
        name,
        description: 'Describe the facts and navigation for this environment.',
        modules: {
          always: [],
          on_demand: [],
        },
      };
      const document: SpaceDocument = { metadata, body: `# ${name}\n` };
      const source = serializeSpaceDocument(document);
      const manifest: StoredManifest = {
        id,
        kind: 'environment',
        createdAt,
        draftSummary: environmentSummaryFromDocument(document),
      };
      const draft: DraftRecord = {
        source,
        savedAt: createdAt,
        form: toEnvironmentForm(document),
      };
      try {
        await this.writeJsonAtomic(path.join(temporaryPath, 'manifest.json'), manifest);
        await this.writeJsonAtomic(path.join(temporaryPath, 'draft.json'), draft);
        await fs.rename(temporaryPath, objectPath);
      } catch (error) {
        await fs.rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      return this.loadEnvironment(id);
    });
  }

  createDraft(input: CreateKnowledgeDraftInput): Promise<KnowledgeModuleDetail> {
    return this.runExclusive(async () => {
      const name = input.name.trim();
      if (!name) throw new Error('Knowledge module name is required');
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const objectPath = this.objectPath(id);
      const temporaryPath = path.join(this.rootPath, `.tmp-${randomUUID()}`);
      await fs.mkdir(path.join(temporaryPath, 'revisions'), { recursive: true });
      const metadata: KnowledgeSpaceMetadata = {
        schema_version: SPACE_SCHEMA_VERSION,
        id,
        kind: 'knowledge',
        name,
        description: 'Describe what this knowledge module contains.',
        when_to_use: 'Describe when this knowledge module should be used.',
      };
      const source = serializeSpaceDocument({
        metadata,
        body: `# ${name}\n`,
      });
      const manifest: StoredManifest = {
        id,
        kind: 'knowledge',
        createdAt,
        draftSummary: summaryFromDocument({ metadata, body: `# ${name}\n` }),
      };
      const draft: DraftRecord = {
        source,
        savedAt: createdAt,
        form: toKnowledgeForm({ metadata, body: `# ${name}\n` }),
      };
      try {
        await this.writeJsonAtomic(path.join(temporaryPath, 'manifest.json'), manifest);
        await this.writeJsonAtomic(path.join(temporaryPath, 'draft.json'), draft);
        await fs.rename(temporaryPath, objectPath);
      } catch (error) {
        await fs.rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      return this.loadModule(id);
    });
  }

  saveFormDraft(id: string, form: KnowledgeModuleFormDraft): Promise<KnowledgeModuleDetail> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'knowledge') {
        throw new Error('Requested object is not a knowledge module');
      }
      let document: SpaceDocument | undefined;
      let source: string;
      try {
        document = spaceDocumentFromForm(toSpaceFormDraft(manifest.id, form));
        source = serializeSpaceDocument(document);
      } catch {
        source = serializeUnvalidatedForm(manifest.id, form);
      }
      assertSpaceSourceSize(source);
      await this.writeDraft(id, source, form);
      if (document) {
        await this.writeJsonAtomic(this.manifestPath(id), {
          ...manifest,
          draftSummary: summaryFromDocument(document),
        });
      }
      return this.loadModule(id);
    });
  }

  saveEnvironmentFormDraft(
    id: string,
    form: EnvironmentFormDraft
  ): Promise<EnvironmentDetail> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'environment') {
        throw new Error('Requested object is not an environment profile');
      }
      let document: SpaceDocument | undefined;
      let source: string;
      try {
        document = spaceDocumentFromForm(toEnvironmentSpaceFormDraft(manifest.id, form));
        source = serializeSpaceDocument(document);
      } catch {
        source = serializeUnvalidatedEnvironmentForm(manifest.id, form);
      }
      assertSpaceSourceSize(source);
      await this.writeDraft(id, source, form);
      if (document) {
        await this.writeJsonAtomic(this.manifestPath(id), {
          ...manifest,
          draftSummary: environmentSummaryFromDocument(document),
        });
      }
      return this.loadEnvironment(id);
    });
  }

  saveSourceDraft(id: string, source: string): Promise<KnowledgeModuleDetail> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'knowledge') {
        throw new Error('Requested object is not a knowledge module');
      }
      assertSpaceSourceSize(source);
      await this.writeDraft(id, source);
      try {
        const document = parseSpaceDocument(source);
        this.assertManagedIdentity(manifest, document);
        if (document.metadata.kind !== 'knowledge') {
          throw new Error('Knowledge draft must use kind: knowledge');
        }
        await this.writeJsonAtomic(this.manifestPath(id), {
          ...manifest,
          draftSummary: summaryFromDocument(document),
        });
      } catch {
        // Invalid source remains recoverable as a draft; publish reports the exact error.
      }
      return this.loadModule(id);
    });
  }

  saveEnvironmentSourceDraft(id: string, source: string): Promise<EnvironmentDetail> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'environment') {
        throw new Error('Requested object is not an environment profile');
      }
      assertSpaceSourceSize(source);
      await this.writeDraft(id, source);
      try {
        const document = parseSpaceDocument(source);
        this.assertManagedIdentity(manifest, document);
        if (document.metadata.kind !== 'environment') {
          throw new Error('Environment draft must use kind: environment');
        }
        await this.writeJsonAtomic(this.manifestPath(id), {
          ...manifest,
          draftSummary: environmentSummaryFromDocument(document),
        });
      } catch {
        // Invalid source remains recoverable as a draft; publish reports the exact error.
      }
      return this.loadEnvironment(id);
    });
  }

  getModule(id: string): Promise<KnowledgeModuleDetail> {
    return this.runExclusive(() => this.loadModule(id));
  }

  getEnvironment(id: string): Promise<EnvironmentDetail> {
    return this.runExclusive(() => this.loadEnvironment(id));
  }

  listManagedFiles(id: string): Promise<ManagedObjectFilesDetail> {
    return this.runExclusive(() => this.loadManagedFiles(id));
  }

  createManagedTextFile(
    id: string,
    input: CreateManagedTextFileInput,
  ): Promise<ManagedObjectFilesDetail> {
    return this.runExclusive(async () => {
      await this.readManifest(id);
      const relativePath = this.assertWritableManagedPath(input.relativePath);
      if (await this.managedFileExists(id, relativePath)) {
        throw new Error(`Managed file already exists: ${relativePath}`);
      }
      const content = input.content ?? '';
      this.assertManagedContentWritable(relativePath, content);
      await this.writeManagedDraftFile(id, relativePath, content);
      return this.loadManagedFiles(id);
    });
  }

  readManagedFileContent(id: string, relativePath: string): Promise<ManagedFileContent> {
    return this.runExclusive(async () => {
      await this.readManifest(id);
      const normalized = this.assertWritableManagedPath(relativePath);
      const content = await this.readManagedDraftFile(id, normalized);
      const origins = await this.readFileOrigins(id);
      return {
        relativePath: normalized,
        content,
        ...(origins[normalized] ? { origin: origins[normalized] } : {}),
      };
    });
  }

  saveManagedFileContent(
    id: string,
    relativePath: string,
    content: string,
  ): Promise<ManagedObjectFilesDetail> {
    return this.runExclusive(async () => {
      await this.readManifest(id);
      const normalized = this.assertWritableManagedPath(relativePath);
      if (!(await this.managedFileExists(id, normalized))) {
        throw new Error(`Managed file does not exist: ${normalized}`);
      }
      this.assertManagedContentWritable(normalized, content);
      await this.writeManagedDraftFile(id, normalized, content);
      return this.loadManagedFiles(id);
    });
  }

  importManagedTextFile(
    id: string,
    input: ImportManagedTextFileInput,
  ): Promise<ManagedObjectFilesDetail> {
    return this.runExclusive(async () => {
      await this.readManifest(id);
      const relativePath = this.assertWritableManagedPath(input.relativePath);
      if (await this.managedFileExists(id, relativePath)) {
        throw new Error(`Managed file already exists: ${relativePath}`);
      }
      const absoluteSourcePath = path.resolve(input.absoluteSourcePath);
      const content = await this.readExternalTextFile(absoluteSourcePath, relativePath);
      this.assertManagedContentWritable(relativePath, content);
      await this.writeManagedDraftFile(id, relativePath, content);
      const origins = await this.readFileOrigins(id);
      origins[relativePath] = {
        sourcePath: absoluteSourcePath,
        originalName: path.basename(absoluteSourcePath),
        importedAt: new Date().toISOString(),
        contentHash: contentSha256(content),
      };
      await this.writeFileOrigins(id, origins);
      return this.loadManagedFiles(id);
    });
  }

  previewUpdateFromSource(id: string, relativePath: string): Promise<SourceUpdatePreview> {
    return this.runExclusive(async () => {
      await this.readManifest(id);
      const normalized = this.assertWritableManagedPath(relativePath);
      const origins = await this.readFileOrigins(id);
      const origin = origins[normalized];
      if (!origin) {
        throw new Error(`Managed file has no recorded source path: ${normalized}`);
      }
      const current = await this.readManagedDraftFile(id, normalized);
      const incoming = await this.readExternalTextFile(origin.sourcePath, normalized);
      return {
        relativePath: normalized,
        sourcePath: origin.sourcePath,
        current,
        incoming,
        unifiedDiff: buildUnifiedDiff(normalized, current, incoming),
        changed: current !== incoming,
      };
    });
  }

  applyUpdateFromSource(id: string, relativePath: string): Promise<ManagedObjectFilesDetail> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      const normalized = this.assertWritableManagedPath(relativePath);
      const origins = await this.readFileOrigins(id);
      const origin = origins[normalized];
      if (!origin) {
        throw new Error(`Managed file has no recorded source path: ${normalized}`);
      }
      const incoming = await this.readExternalTextFile(origin.sourcePath, normalized);
      this.assertManagedContentWritable(normalized, incoming);
      await this.writeManagedDraftFile(id, normalized, incoming);
      origins[normalized] = {
        ...origin,
        importedAt: new Date().toISOString(),
        contentHash: contentSha256(incoming),
      };
      await this.writeFileOrigins(id, origins);
      // Explicit source updates create a new managed revision (ADR-009), not only a draft.
      await this.publishObjectDraft(id, manifestKind(manifest));
      return this.loadManagedFiles(id);
    });
  }

  renameManagedFile(
    id: string,
    fromRelativePath: string,
    toRelativePath: string,
  ): Promise<ManagedObjectFilesDetail> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      const from = this.assertWritableManagedPath(fromRelativePath);
      const to = this.assertWritableManagedPath(toRelativePath);
      if (!(await this.managedFileExists(id, from))) {
        throw new Error(`Managed file does not exist: ${from}`);
      }
      if (await this.managedFileExists(id, to)) {
        throw new Error(`Managed file already exists: ${to}`);
      }
      const content = await this.readManagedDraftFile(id, from);
      await this.writeManagedDraftFile(id, to, content);
      await fs.rm(this.managedDraftAbsolutePath(id, from), { force: true });
      await this.pruneEmptyDraftDirectories(id, path.posix.dirname(from));
      await this.mergeExternalBaselineFiles(id, {}, [from]);

      const origins = await this.readFileOrigins(id);
      if (origins[from]) {
        origins[to] = origins[from];
        delete origins[from];
        await this.writeFileOrigins(id, origins);
      }

      if (manifestKind(manifest) === 'knowledge') {
        await this.rewriteGuidanceFiles(id, (files) => files.map((file) => (
          file === from ? to : file
        )));
      }
      return this.loadManagedFiles(id);
    });
  }

  removeManagedFile(id: string, relativePath: string): Promise<ManagedObjectFilesDetail> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      const normalized = this.assertWritableManagedPath(relativePath);
      if (!(await this.managedFileExists(id, normalized))) {
        throw new Error(`Managed file does not exist: ${normalized}`);
      }
      await fs.rm(this.managedDraftAbsolutePath(id, normalized), { force: true });
      await this.pruneEmptyDraftDirectories(id, path.posix.dirname(normalized));
      await this.mergeExternalBaselineFiles(id, {}, [normalized]);

      const origins = await this.readFileOrigins(id);
      if (origins[normalized]) {
        delete origins[normalized];
        await this.writeFileOrigins(id, origins);
      }

      if (manifestKind(manifest) === 'knowledge') {
        await this.rewriteGuidanceFiles(id, (files) => files.filter((file) => file !== normalized));
      }
      return this.loadManagedFiles(id);
    });
  }

  setGuidanceRegistration(
    id: string,
    relativePath: string,
    registered: boolean,
  ): Promise<ManagedObjectFilesDetail> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'knowledge') {
        throw new Error('Environment profiles cannot register guidance files');
      }
      const normalized = this.assertWritableManagedPath(relativePath);
      if (!(await this.managedFileExists(id, normalized))) {
        throw new Error(`Managed file does not exist: ${normalized}`);
      }
      if (registered && !isGuidanceEligiblePath(normalized)) {
        throw new Error(`Guidance file must be Markdown or text: ${normalized}`);
      }
      await this.rewriteGuidanceFiles(id, (files) => {
        const without = files.filter((file) => file !== normalized);
        if (!registered) return without;
        if (without.length >= SPACE_V1_LIMITS.maxGuidanceFiles) {
          throw new Error(`Guidance files exceed ${SPACE_V1_LIMITS.maxGuidanceFiles}`);
        }
        return [...without, normalized].sort((left, right) => left.localeCompare(right, 'en-US'));
      });
      return this.loadManagedFiles(id);
    });
  }

  listModules(): Promise<KnowledgeModuleSummary[]> {
    return this.runExclusive(async () => {
      const ids = await this.listObjectIds();
      const modules: KnowledgeModuleSummary[] = [];
      for (const id of ids) {
        const manifest = await this.readManifest(id);
        if (manifestKind(manifest) !== 'knowledge') continue;
        const detail = await this.loadModule(id);
        const { source: _source, form: _form, draftValidationError: _error, ...summary } = detail;
        modules.push(summary);
      }
      return modules.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  listPublished(): Promise<PublishedKnowledgeModuleSummary[]> {
    return this.runExclusive(() => this.listPublishedModules(false));
  }

  listAutomaticCandidates(): Promise<PublishedKnowledgeModuleSummary[]> {
    return this.runExclusive(() => this.listPublishedModules(true));
  }

  listEnvironments(): Promise<EnvironmentSummary[]> {
    return this.runExclusive(async () => {
      const ids = await this.listObjectIds();
      const environments: EnvironmentSummary[] = [];
      for (const id of ids) {
        const manifest = await this.readManifest(id);
        if (manifestKind(manifest) !== 'environment') continue;
        const detail = await this.loadEnvironment(id);
        const {
          source: _source,
          form: _form,
          associations: _associations,
          draftValidationError: _error,
          ...summary
        } = detail;
        environments.push(summary);
      }
      return environments.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  listPublishedEnvironments(): Promise<PublishedEnvironmentSummary[]> {
    return this.runExclusive(async () => {
      const ids = await this.listObjectIds();
      const environments: PublishedEnvironmentSummary[] = [];
      for (const id of ids) {
        const manifest = await this.readManifest(id);
        if (manifestKind(manifest) !== 'environment' || !manifest.latestRevision) continue;
        environments.push(await this.loadPublishedEnvironmentSummary(manifest));
      }
      return environments.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  /**
   * Open the active published revision root for harness reads.
   * Returns undefined when the object is missing, unpublished, or no longer available.
   */
  /**
   * Open a published revision root for harness reads.
   * When `revision` is omitted, the latest valid revision is used.
   * When provided, that managed snapshot is returned even if a newer save exists.
   */
  resolvePublishedObject(
    id: string,
    revision?: number,
  ): Promise<PublishedObjectRoot | undefined> {
    return this.runExclusive(() => this.resolvePublishedObjectUnlocked(id, revision));
  }

  publishDraft(id: string): Promise<KnowledgeRevision> {
    return this.runExclusive(() => this.publishObjectDraft(id, 'knowledge'));
  }

  publishEnvironmentDraft(id: string): Promise<SpaceRevision> {
    return this.runExclusive(() => this.publishObjectDraft(id, 'environment'));
  }

  /**
   * Apply an accepted AI proposal onto a managed object through the normal
   * draft → secret/schema/path validation → publish pipeline (ADR-040).
   * Host Notes are applied by the desktop host store, not here.
   */
  applyAcceptedKnowledgeProposal(
    id: string,
    options: {
      expectedKind: 'environment' | 'knowledge';
      baseRevision: number;
      baseContentHash: string;
      files: readonly { relativePath: string; content: string }[];
    },
  ): Promise<SpaceRevision> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      const kind = manifestKind(manifest);
      if (kind !== options.expectedKind) {
        throw new Error(`Requested object is not a ${options.expectedKind}`);
      }
      if (!manifest.latestRevision) {
        throw new Error('Object has no published revision to base a proposal on');
      }
      if (manifest.latestRevision !== options.baseRevision) {
        throw new Error(
          `Proposal base revision is stale (expected ${options.baseRevision}, latest ${manifest.latestRevision})`,
        );
      }
      const base = await this.readRevision(id, options.baseRevision);
      if (base.contentHash !== options.baseContentHash) {
        throw new Error('Proposal base content hash is stale');
      }

      const baseSnapshots = await this.readRevisionFileSnapshots(id, options.baseRevision);
      const merged = new Map(baseSnapshots.map((file) => [file.relativePath, file.content]));
      for (const file of options.files) {
        const relativePath = file.relativePath === 'SPACE.md'
          ? 'SPACE.md'
          : this.assertWritableManagedPath(file.relativePath);
        if (relativePath !== 'SPACE.md') {
          this.assertManagedContentWritable(relativePath, file.content);
        } else {
          assertSpaceSourceSize(file.content);
        }
        merged.set(relativePath, file.content);
      }

      const entry = merged.get('SPACE.md');
      if (entry === undefined) {
        throw new Error('Proposal must leave a SPACE.md entry');
      }
      const document = parseSpaceDocument(entry);
      this.assertManagedIdentity(manifest, document);
      if (document.metadata.kind !== kind) {
        throw new Error(`Proposal kind must remain ${kind}`);
      }
      if (kind === 'environment') {
        // Environments reject Guidance entirely (schema + body).
        if (/\n##\s+Guidance\s*$/m.test(entry) || /^##\s+Guidance\s*$/m.test(entry)) {
          throw new Error('Environment profiles cannot contain Guidance');
        }
      }

      // Validate secrets/schema on the proposed tree before mutating the draft.
      const source = serializeSpaceDocument(document);
      const managedFiles = [...merged.entries()]
        .filter(([relativePath]) => relativePath !== 'SPACE.md')
        .map(([relativePath, content]) => ({ relativePath, content }));
      const entryScan = scanKnowledgeSecrets(source);
      if (entryScan.status !== 'clean') {
        const finding = entryScan.findings[0];
        throw new Error(
          `Draft contains a possible secret (${finding?.ruleId ?? 'unknown'} at line ${finding?.line ?? 1})`,
        );
      }
      for (const file of managedFiles) {
        const fileScan = scanKnowledgeSecrets(file.content);
        if (fileScan.status !== 'clean') {
          const finding = fileScan.findings[0];
          throw new Error(
            `Managed file contains a possible secret (${finding?.ruleId ?? 'unknown'} at ${file.relativePath}:${finding?.line ?? 1})`,
          );
        }
      }

      const form = document.metadata.kind === 'knowledge'
        ? toKnowledgeForm(document)
        : toEnvironmentForm(document);
      await this.writeDraft(id, source, form);

      const snapshots: RevisionFileSnapshot[] = [...merged.entries()].map(([relativePath, content]) => ({
        relativePath,
        content,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        contentHash: contentSha256(content),
      }));
      await this.rewriteWorkingTreeFromSnapshots(id, snapshots);
      await this.captureExternalBaseline(id);

      return this.publishObjectDraftUnlocked(id, kind, {
        origin: proposalOrigin(),
        allowExternalPending: true,
      });
    });
  }

  /** Read published revision file snapshots for proposal base materialization. */
  readPublishedRevisionFiles(
    id: string,
    revision?: number,
  ): Promise<RevisionFileSnapshot[]> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      const target = revision ?? manifest.latestRevision;
      if (!target) throw new Error('Object has no published revision');
      return this.readRevisionFileSnapshots(id, target);
    });
  }

  /**
   * Absolute path of the managed content root (`draft-files`) for “open folder”.
   * Never returns the object system root (manifest/revisions/blobs).
   */
  getManagedObjectRootPath(id: string): Promise<string> {
    return this.runExclusive(async () => {
      await this.readManifest(id);
      await fs.mkdir(this.draftFilesPath(id), { recursive: true });
      await this.ensureWorkingSpaceFile(id);
      await this.ensureExternalBaseline(id);
      return this.draftFilesPath(id);
    });
  }

  /** Compare the working tree to the last app-known baseline (startup / watcher). */
  scanExternalChanges(id: string): Promise<ExternalChangeStatus> {
    return this.runExclusive(() => this.scanExternalChangesUnlocked(id));
  }

  /** Scan every active object root for external edits. */
  scanAllExternalChanges(): Promise<ExternalChangeStatus[]> {
    return this.runExclusive(async () => {
      const ids = await this.listObjectIds();
      const results: ExternalChangeStatus[] = [];
      for (const id of ids) {
        results.push(await this.scanExternalChangesUnlocked(id));
      }
      return results.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    });
  }

  /** Diff + validate pending external working-tree content before adopt. */
  previewExternalChanges(id: string): Promise<ExternalChangePreview> {
    return this.runExclusive(async () => {
      const status = await this.scanExternalChangesUnlocked(id);
      return {
        ...status,
        canAdopt: status.status === 'pending' && status.validationErrors.length === 0,
      };
    });
  }

  /**
   * Adopt validated external working-tree content as a new valid revision.
   * Agent activity still requires explicit revision apply (ADR-050).
   */
  adoptExternalChanges(id: string): Promise<SpaceRevision> {
    return this.runExclusive(async () => {
      const status = await this.scanExternalChangesUnlocked(id);
      if (status.status === 'clean') {
        throw new Error('No external changes to adopt');
      }
      if (status.status === 'invalid' || status.validationErrors.length > 0) {
        throw new Error(
          `External changes failed validation and cannot be adopted: ${
            status.validationErrors[0] ?? 'unknown error'
          }`,
        );
      }

      const manifest = await this.readManifest(id);
      const kind = manifestKind(manifest);
      const working = await this.readWorkingTreeSnapshots(id);
      const entry = working.find((file) => file.relativePath === 'SPACE.md');
      if (!entry) {
        throw new Error('External changes failed validation and cannot be adopted: missing SPACE.md');
      }

      const document = parseSpaceDocument(entry.content);
      this.assertManagedIdentity(manifest, document);
      if (document.metadata.kind !== kind) {
        throw new Error(
          `External changes failed validation and cannot be adopted: kind must be ${kind}`,
        );
      }

      const source = serializeSpaceDocument(document);
      const form = document.metadata.kind === 'knowledge'
        ? toKnowledgeForm(document)
        : toEnvironmentForm(document);
      await this.writeDraft(id, source, form);
      // Materialise non-entry files exactly as on disk (already present); drop temps.
      await this.rewriteWorkingTreeFromSnapshots(id, working);

      const revision = await this.publishObjectDraftUnlocked(id, kind, {
        origin: externalOrigin(),
        // Working tree is the adopted content; baseline is rewritten after publish.
        allowExternalPending: true,
      });
      await this.captureExternalBaseline(id);
      return revision;
    });
  }

  /**
   * Discard external working-tree edits and restore the last valid revision content.
   */
  discardExternalChanges(id: string): Promise<void> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (!manifest.latestRevision) {
        throw new Error('No valid revision available to restore');
      }
      const kind = manifestKind(manifest);
      const snapshots = await this.readRevisionFileSnapshots(id, manifest.latestRevision);
      const entry = snapshots.find((file) => file.relativePath === 'SPACE.md');
      if (!entry) {
        throw new Error(`Revision ${manifest.latestRevision} is missing SPACE.md`);
      }
      const document = parseSpaceDocument(entry.content);
      this.assertManagedIdentity(manifest, document);
      if (document.metadata.kind !== kind) {
        throw new Error(`Cannot restore revision ${manifest.latestRevision}: kind mismatch`);
      }
      const source = serializeSpaceDocument(document);
      const form = document.metadata.kind === 'knowledge'
        ? toKnowledgeForm(document)
        : toEnvironmentForm(document);
      await this.writeDraft(id, source, form);
      await this.rewriteWorkingTreeFromSnapshots(id, snapshots);
      await this.captureExternalBaseline(id);
    });
  }

  /**
   * List stored valid revisions newest-first with protection / Agent-active markers.
   * Does not auto-delete history (ADR-059).
   */
  listRevisionHistory(
    id: string,
    protection: Omit<RevisionProtectionInput, 'latestRevision'> = {},
  ): Promise<RevisionHistoryEntry[]> {
    return this.runExclusive(() => this.listRevisionHistoryUnlocked(id, protection));
  }

  /** Compare entry + object files between two stored valid revisions. */
  compareRevisions(
    id: string,
    leftRevision: number,
    rightRevision: number,
  ): Promise<RevisionComparison> {
    return this.runExclusive(async () => {
      const left = await this.readRevision(id, leftRevision);
      const right = await this.readRevision(id, rightRevision);
      const leftFiles = await this.readRevisionFileSnapshots(id, leftRevision);
      const rightFiles = await this.readRevisionFileSnapshots(id, rightRevision);
      return buildRevisionComparison({
        objectId: id,
        leftRevision,
        rightRevision,
        leftContentHash: left.contentHash,
        rightContentHash: right.contentHash,
        leftFiles,
        rightFiles,
      });
    });
  }

  /**
   * Restore a historical revision by creating a new valid revision with the same
   * content. History is never rewritten.
   */
  restoreRevision(id: string, revision: number): Promise<SpaceRevision> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      const kind = manifestKind(manifest);
      const historical = await this.readRevision(id, revision);
      const snapshots = await this.readRevisionFileSnapshots(id, revision);
      const entry = snapshots.find((file) => file.relativePath === 'SPACE.md');
      if (!entry) throw new Error(`Revision ${revision} is missing SPACE.md`);

      const document = parseSpaceDocument(entry.content);
      this.assertManagedIdentity(manifest, document);
      if (document.metadata.kind !== kind) {
        throw new Error(`Cannot restore revision ${revision}: kind mismatch`);
      }

      const source = serializeSpaceDocument(document);
      const form = document.metadata.kind === 'knowledge'
        ? toKnowledgeForm(document)
        : toEnvironmentForm(document);
      await this.writeDraft(id, source, form);

      // Replace managed draft files with the historical snapshot.
      await fs.rm(this.draftFilesPath(id), { recursive: true, force: true });
      for (const file of snapshots) {
        if (file.relativePath === 'SPACE.md') continue;
        await this.writeManagedDraftFile(id, file.relativePath, file.content);
      }
      // Full baseline must match the restored tree before publish (no stale paths).
      await this.captureExternalBaseline(id);

      return this.publishObjectDraftUnlocked(id, kind, {
        origin: restoreOrigin(revision),
        // Already validated when the historical revision was created.
        skipSecretScan: false,
      });
    });
  }

  previewRevisionCleanup(
    id: string,
    revisions: readonly number[],
    protection: Omit<RevisionProtectionInput, 'latestRevision'> = {},
  ): Promise<RevisionCleanupPreview> {
    return this.runExclusive(() => this.previewRevisionCleanupUnlocked(id, revisions, protection));
  }

  cleanupRevisions(
    id: string,
    revisions: readonly number[],
    protection: Omit<RevisionProtectionInput, 'latestRevision'> = {},
  ): Promise<RevisionCleanupResult> {
    return this.runExclusive(async () => {
      const preview = await this.previewRevisionCleanupUnlocked(id, revisions, protection);
      assertCleanupAllowed(preview);

      const removedRevisions: number[] = [];
      for (const revision of preview.removableRevisions) {
        const revisionDir = this.revisionPath(id, revision);
        try {
          await fs.rm(revisionDir, { recursive: true, force: true });
          removedRevisions.push(revision);
        } catch (error) {
          // Keep remaining revisions and blob refs consistent for a safe retry.
          if (removedRevisions.length > 0) {
            await this.garbageCollectBlobs(id);
          }
          throw error;
        }
      }

      const freedBytes = await this.garbageCollectBlobs(id);
      return {
        objectId: id,
        removedRevisions,
        freedBytes: Math.max(freedBytes, preview.estimatedFreedBytes),
      };
    });
  }

  /**
   * Preview deleting a knowledge module: lists reverse environment references
   * and whether the module can enter the 30-day trash (ADR-023).
   */
  previewDeleteModule(id: string): Promise<ModuleDeletePreview> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'knowledge') {
        throw new Error('Requested object is not a knowledge module');
      }
      const referencedBy = await this.collectModuleReferences(id);
      return planModuleDelete({
        id,
        name: manifest.draftSummary.name,
        referencedBy,
      });
    });
  }

  /**
   * Preview deleting an environment profile. `boundHosts` comes from local host
   * bindings (desktop HostStore); core never reads host configuration itself.
   */
  previewDeleteEnvironment(
    id: string,
    boundHosts: readonly EnvironmentHostBinding[] = [],
  ): Promise<EnvironmentDeletePreview> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'environment') {
        throw new Error('Requested object is not an environment profile');
      }
      const associations = await this.readEnvironmentAssociationIds(id);
      return planEnvironmentDelete({
        id,
        name: manifest.draftSummary.name,
        boundHosts,
        associations,
      });
    });
  }

  /** Move an unreferenced knowledge module into the recoverable trash. */
  moveModuleToTrash(id: string): Promise<TrashMoveResult> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'knowledge') {
        throw new Error('Requested object is not a knowledge module');
      }
      const referencedBy = await this.collectModuleReferences(id);
      const preview = planModuleDelete({
        id,
        name: manifest.draftSummary.name,
        referencedBy,
      });
      assertCanMoveToTrash(preview);
      const snapshot: TrashReferenceSnapshot = {
        ...emptyReferenceSnapshot(),
        referencedBy,
      };
      return this.moveObjectToTrashUnlocked(id, 'knowledge', snapshot);
    });
  }

  /**
   * Move an unbound environment profile into trash. Associated knowledge modules
   * are retained; associations are snapshotted for restore reporting.
   */
  moveEnvironmentToTrash(
    id: string,
    boundHosts: readonly EnvironmentHostBinding[] = [],
  ): Promise<TrashMoveResult> {
    return this.runExclusive(async () => {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'environment') {
        throw new Error('Requested object is not an environment profile');
      }
      const associations = await this.readEnvironmentAssociationIds(id);
      const preview = planEnvironmentDelete({
        id,
        name: manifest.draftSummary.name,
        boundHosts,
        associations,
      });
      assertCanMoveToTrash(preview);
      const snapshot: TrashReferenceSnapshot = {
        ...emptyReferenceSnapshot(),
        associations,
        boundHosts: [...boundHosts],
      };
      return this.moveObjectToTrashUnlocked(id, 'environment', snapshot);
    });
  }

  listTrash(now: Date = new Date()): Promise<TrashEntrySummary[]> {
    return this.runExclusive(async () => {
      await this.repairTrashStateUnlocked();
      const records = await this.listTrashRecords();
      return records
        .map((record) => this.toTrashSummary(record, now))
        .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
    });
  }

  getTrashEntry(id: string, now: Date = new Date()): Promise<TrashEntryDetail> {
    return this.runExclusive(async () => {
      await this.repairTrashStateUnlocked();
      const record = await this.readTrashRecord(id);
      return {
        ...this.toTrashSummary(record, now),
        referenceSnapshot: record.referenceSnapshot,
      };
    });
  }

  /**
   * Restore a trashed object using its original stable ID. Environment associations
   * from the snapshot are reported without overwriting post-delete conflicts.
   */
  restoreFromTrash(id: string): Promise<TrashRestoreResult> {
    return this.runExclusive(async () => {
      await this.repairTrashStateUnlocked();
      assertSafeId(id);
      const trashPath = this.trashObjectPath(id);
      const activePath = this.objectPath(id);
      if (await pathExists(activePath)) {
        throw new Error(`Cannot restore ${id}: an active object already uses this stable ID`);
      }
      let record: TrashRecord;
      try {
        record = await this.readTrashRecord(id);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          throw new Error(`Trash entry not found: ${id}`);
        }
        throw error;
      }

      // Atomic rename back into the active object namespace.
      try {
        await fs.rename(trashPath, activePath);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          throw new Error(`Trash entry not found: ${id}`);
        }
        throw error;
      }

      try {
        await fs.rm(path.join(activePath, 'trash.json'), { force: true });
      } catch {
        // Marker removal failure is non-fatal; next repair will clean it if needed.
      }

      const associationResults = await this.reportRestoredAssociations(record);
      return {
        id: record.id,
        kind: record.kind,
        name: record.name,
        associationResults,
      };
    });
  }

  previewPermanentDelete(
    id: string,
    options: { agentActiveRevisions?: readonly number[]; now?: Date } = {},
  ): Promise<PermanentDeletePreview> {
    return this.runExclusive(async () => {
      await this.repairTrashStateUnlocked();
      const record = await this.readTrashRecord(id);
      return planPermanentDelete({
        record,
        now: options.now,
        agentActiveRevisions: options.agentActiveRevisions,
      });
    });
  }

  permanentlyDeleteFromTrash(
    id: string,
    options: { agentActiveRevisions?: readonly number[]; now?: Date } = {},
  ): Promise<void> {
    return this.runExclusive(async () => {
      await this.repairTrashStateUnlocked();
      const record = await this.readTrashRecord(id);
      const preview = planPermanentDelete({
        record,
        now: options.now,
        agentActiveRevisions: options.agentActiveRevisions,
      });
      if (!preview.canPermanentlyDelete) {
        throw new Error(preview.blockers[0]?.message ?? 'Cannot permanently delete trash entry');
      }
      await fs.rm(this.trashObjectPath(id), { recursive: true, force: true });
    });
  }

  /**
   * Permanently remove trash entries past the retention window.
   * Agent-active pins are skipped so a safe retry remains possible.
   */
  purgeExpiredTrash(
    now: Date = new Date(),
    options: { agentActiveById?: ReadonlyMap<string, readonly number[]> } = {},
  ): Promise<TrashPurgeResult> {
    return this.runExclusive(async () => {
      await this.repairTrashStateUnlocked();
      const records = await this.listTrashRecords();
      const expired = selectExpiredTrashEntries(records, now);
      const purgedIds: string[] = [];
      const skippedIds: string[] = [];
      for (const record of expired) {
        const agentActive = options.agentActiveById?.get(record.id) ?? [];
        const preview = planPermanentDelete({
          record,
          now,
          agentActiveRevisions: agentActive,
        });
        if (!preview.canPermanentlyDelete) {
          skippedIds.push(record.id);
          continue;
        }
        await fs.rm(this.trashObjectPath(record.id), { recursive: true, force: true });
        purgedIds.push(record.id);
      }
      return { purgedIds, skippedIds };
    });
  }

  /**
   * Repair crash-interrupted trash moves so delete/restore stay consistent
   * (trash.json written under active object before rename completed).
   */
  repairTrashState(): Promise<TrashRepairResult> {
    return this.runExclusive(() => this.repairTrashStateUnlocked());
  }

  /**
   * Preview an environment export: lists the published environment and every direct
   * always/on_demand module dependency (resolved or unresolved) before packaging.
   */
  previewEnvironmentExport(id: string): Promise<EnvironmentExportPreview> {
    return this.runExclusive(async () => {
      const published = await this.resolvePublishedObjectUnlocked(id);
      if (!published || published.kind !== 'environment') {
        throw new Error('Environment has no published revision to export');
      }
      const root = await SafeObjectRoot.open(published.rootPath);
      const listed = await root.listTextFiles();
      const space = listed.find((file) => file.relativePath === 'SPACE.md');
      if (!space) {
        throw new Error('Published environment is missing SPACE.md');
      }
      const document = parseSpaceDocument(space.content);
      if (document.metadata.kind !== 'environment') {
        throw new Error('Published object is not an environment profile');
      }

      const modules: EnvironmentExportModulePreview[] = [];
      for (const moduleId of document.metadata.modules.always) {
        modules.push(await this.previewExportModuleDependency(moduleId, 'always'));
      }
      for (const moduleId of document.metadata.modules.on_demand) {
        modules.push(await this.previewExportModuleDependency(moduleId, 'on_demand'));
      }

      return {
        environment: {
          id: published.id,
          name: published.name,
          revision: published.revision,
          contentHash: published.contentHash,
        },
        modules,
        modeDefault: 'self-contained',
      };
    });
  }

  /**
   * Export a published environment as a self-contained dependency bundle (default)
   * or as an advanced definition-only package that keeps stable module ID references.
   * Host bindings, local authorization, Host Notes and credentials are never included.
   */
  exportEnvironment(
    id: string,
    packagePath: string,
    mode: EnvironmentExportMode = 'self-contained',
  ): Promise<ExportedEnvironmentPackage> {
    return this.runExclusive(async () => {
      const published = await this.resolvePublishedObjectUnlocked(id);
      if (!published || published.kind !== 'environment') {
        throw new Error('Environment has no published revision to export');
      }
      const root = await SafeObjectRoot.open(published.rootPath);
      const listed = await root.listTextFiles();
      const envFiles = listed
        .filter((file) => file.relativePath !== 'revision.json')
        .map((file) => ({
          relativePath: file.relativePath,
          content: file.content,
        }));
      const builtEnvironment = buildEnvironmentObjectPackage({
        files: envFiles,
        contentHash: published.contentHash,
      });
      if (builtEnvironment.payload.id !== id) {
        throw new Error('Published environment stable id does not match requested id');
      }

      const referenced = environmentReferencedModuleIds(builtEnvironment.document);
      const modulePackages: BuiltKnowledgeModulePackage[] = [];
      const unresolvedModuleIds: string[] = [];

      if (mode === 'self-contained') {
        for (const moduleId of referenced.all) {
          const modulePublished = await this.resolvePublishedObjectUnlocked(moduleId);
          if (!modulePublished || modulePublished.kind !== 'knowledge') {
            unresolvedModuleIds.push(moduleId);
            continue;
          }
          const moduleRoot = await SafeObjectRoot.open(modulePublished.rootPath);
          const moduleListed = await moduleRoot.listTextFiles();
          const moduleFiles = moduleListed
            .filter((file) => file.relativePath !== 'revision.json')
            .map((file) => ({
              relativePath: file.relativePath,
              content: file.content,
            }));
          const builtModule = buildKnowledgeModulePackage({
            files: moduleFiles,
            contentHash: modulePublished.contentHash,
            exportedAt: new Date().toISOString(),
          });
          if (builtModule.package.id !== moduleId) {
            throw new Error(`Published module stable id does not match association: ${moduleId}`);
          }
          modulePackages.push(builtModule);
        }
      } else {
        unresolvedModuleIds.push(...referenced.all);
      }

      const packageKind: EnvironmentPackageKind = mode === 'self-contained'
        ? ENVIRONMENT_BUNDLE_KIND
        : ENVIRONMENT_DEFINITION_KIND;
      const built = buildEnvironmentPackage({
        packageKind,
        environment: builtEnvironment,
        modules: modulePackages,
        exportedAt: new Date().toISOString(),
      });

      // Re-verify environment hash against the normalized package payload.
      const stagingPath = path.join(this.rootPath, `.tmp-export-env-${randomUUID()}`);
      try {
        await fs.mkdir(stagingPath, { recursive: true });
        for (const file of built.environment.payload.files) {
          const targetPath = path.join(stagingPath, ...file.relative_path.split('/'));
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, file.content, 'utf8');
        }
        const loaded = await loadSpaceObject(stagingPath);
        if (loaded.contentHash !== published.contentHash) {
          throw new Error(
            `Export content hash mismatch: expected ${published.contentHash}, got ${loaded.contentHash}`,
          );
        }
        const payload = serializeEnvironmentPackage({
          ...built.package,
          environment: {
            ...built.package.environment,
            content_hash: loaded.contentHash,
          },
        });
        await fs.mkdir(path.dirname(path.resolve(packagePath)), { recursive: true });
        const temporaryPackagePath = `${packagePath}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporaryPackagePath, payload, { encoding: 'utf8', flag: 'wx' });
          await fs.rename(temporaryPackagePath, packagePath);
        } catch (error) {
          await fs.rm(temporaryPackagePath, { force: true });
          throw error;
        }
        return {
          id: published.id,
          name: published.name,
          contentHash: loaded.contentHash,
          packagePath: path.resolve(packagePath),
          mode,
          moduleCount: modulePackages.length,
          unresolvedModuleIds,
        };
      } finally {
        await fs.rm(stagingPath, { recursive: true, force: true });
      }
    });
  }

  /**
   * Validate an environment package and classify environment/module create, identical,
   * conflict, and missing statuses before any durable write.
   */
  previewEnvironmentImport(packagePath: string): Promise<EnvironmentImportPreview> {
    return this.runExclusive(async () => {
      const stagingPath = path.join(this.rootPath, `.tmp-import-env-preview-${randomUUID()}`);
      try {
        const built = await loadAndValidateEnvironmentPackage(packagePath, stagingPath);
        return this.classifyEnvironmentImport(built, packagePath);
      } finally {
        await fs.rm(stagingPath, { recursive: true, force: true });
      }
    });
  }

  /**
   * Import an environment package after all conflict choices are supplied.
   * Writes are deferred until validation completes; host bindings and local
   * module authorizations on the target machine are never modified.
   * On failure, newly created objects and appended revisions are rolled back.
   */
  importEnvironment(
    packagePath: string,
    resolutions: EnvironmentImportResolutions = {},
  ): Promise<EnvironmentImportResult> {
    return this.runExclusive(async () => {
      const stagingPath = path.join(this.rootPath, `.tmp-import-env-${randomUUID()}`);
      const rollbackLog: EnvironmentImportRollbackEntry[] = [];
      try {
        const built = await loadAndValidateEnvironmentPackage(packagePath, stagingPath);
        const preview = await this.classifyEnvironmentImport(built, packagePath);
        this.assertEnvironmentImportResolutions(preview, resolutions);
        await this.assertImportTargetsWritable(preview);

        const mode: EnvironmentExportMode = built.package.package_kind === ENVIRONMENT_BUNDLE_KIND
          ? 'self-contained'
          : 'definition-only';

        // Apply modules first so environment associations can resolve after materialization.
        const moduleResults: Array<ModuleImportResult & { sourceId?: string }> = [];
        const moduleIdMap = new Map<string, string>();

        for (const modulePreview of preview.modules) {
          if (modulePreview.status === 'missing') {
            continue;
          }
          const builtModule = built.modules.find(
            (module) => module.package.id === modulePreview.id,
          );
          if (!builtModule) {
            // Definition-only packages have no payloads; leave associations unresolved.
            continue;
          }
          const resolution = resolutions.moduleResolutions?.[modulePreview.id];
          const result = await this.applyModuleImportDecision(
            builtModule,
            modulePreview,
            resolution,
            rollbackLog,
          );
          moduleResults.push(result);
          if (result.status === 'copied') {
            moduleIdMap.set(modulePreview.id, result.id);
          }
        }

        let environmentBuilt = built.environment;
        if (moduleIdMap.size > 0) {
          environmentBuilt = rewriteEnvironmentModuleAssociations(
            environmentBuilt,
            moduleIdMap,
          );
          // Recompute authoritative content hash after association rewrite.
          const remapStaging = path.join(this.rootPath, `.tmp-import-env-remap-${randomUUID()}`);
          try {
            await fs.mkdir(remapStaging, { recursive: true });
            for (const file of environmentBuilt.payload.files) {
              const targetPath = path.join(remapStaging, ...file.relative_path.split('/'));
              await fs.mkdir(path.dirname(targetPath), { recursive: true });
              await fs.writeFile(targetPath, file.content, 'utf8');
            }
            const loaded = await loadSpaceObject(remapStaging);
            environmentBuilt = buildEnvironmentObjectPackage({
              files: environmentBuilt.payload.files.map((file) => ({
                relativePath: file.relative_path,
                content: file.content,
              })),
              contentHash: loaded.contentHash,
            });
          } finally {
            await fs.rm(remapStaging, { recursive: true, force: true });
          }
        }

        const environmentResult = await this.applyEnvironmentImportDecision(
          environmentBuilt,
          preview.environment,
          resolutions.environmentResolution,
          rollbackLog,
        );

        // Recompute unresolved associations from the final environment state.
        const finalEnvironment = await this.loadEnvironment(environmentResult.id);
        const unresolvedModuleIds = [
          ...finalEnvironment.associations.always,
          ...finalEnvironment.associations.onDemand,
        ]
          .filter((dependency) => dependency.status === 'unresolved')
          .map((dependency) => dependency.id);

        return {
          environment: environmentResult,
          modules: moduleResults,
          unresolvedModuleIds,
          mode,
        };
      } catch (error) {
        await this.rollbackEnvironmentImport(rollbackLog);
        throw error;
      } finally {
        await fs.rm(stagingPath, { recursive: true, force: true });
      }
    });
  }

  /**
   * Export the latest published knowledge module revision as a portable package.
   * Drafts, host bindings, local authorizations, file origins and credentials are excluded.
   */
  exportKnowledgeModule(
    id: string,
    packagePath: string,
  ): Promise<ExportedKnowledgeModulePackage> {
    return this.runExclusive(async () => {
      const published = await this.resolvePublishedObjectUnlocked(id);
      if (!published || published.kind !== 'knowledge') {
        throw new Error('Knowledge module has no published revision to export');
      }
      const root = await SafeObjectRoot.open(published.rootPath);
      const listed = await root.listTextFiles();
      const files = listed
        .filter((file) => file.relativePath !== 'revision.json')
        .map((file) => ({
          relativePath: file.relativePath,
          content: file.content,
        }));
      const built = buildKnowledgeModulePackage({
        files,
        contentHash: published.contentHash,
        exportedAt: new Date().toISOString(),
      });
      if (built.package.id !== id) {
        throw new Error('Published module stable id does not match requested id');
      }
      // Re-verify hash against the normalized package payload.
      const stagingPath = path.join(this.rootPath, `.tmp-export-${randomUUID()}`);
      try {
        await fs.mkdir(stagingPath, { recursive: true });
        for (const file of built.package.files) {
          const targetPath = path.join(stagingPath, ...file.relative_path.split('/'));
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, file.content, 'utf8');
        }
        const loaded = await loadSpaceObject(stagingPath);
        if (loaded.contentHash !== published.contentHash) {
          throw new Error(
            `Export content hash mismatch: expected ${published.contentHash}, got ${loaded.contentHash}`
          );
        }
        const payload = serializeKnowledgeModulePackage({
          ...built.package,
          content_hash: loaded.contentHash,
        });
        await fs.mkdir(path.dirname(path.resolve(packagePath)), { recursive: true });
        const temporaryPackagePath = `${packagePath}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporaryPackagePath, payload, { encoding: 'utf8', flag: 'wx' });
          await fs.rename(temporaryPackagePath, packagePath);
        } catch (error) {
          await fs.rm(temporaryPackagePath, { force: true });
          throw error;
        }
        return {
          id: published.id,
          name: published.name,
          contentHash: loaded.contentHash,
          packagePath: path.resolve(packagePath),
        };
      } finally {
        await fs.rm(stagingPath, { recursive: true, force: true });
      }
    });
  }

  /** Validate a package and classify create / identical / conflict before any write. */
  previewKnowledgeModuleImport(packagePath: string): Promise<ModuleImportPreview> {
    return this.runExclusive(async () => {
      const stagingPath = path.join(this.rootPath, `.tmp-import-preview-${randomUUID()}`);
      try {
        const built = await loadAndValidateKnowledgeModulePackage(packagePath, stagingPath);
        const incoming: ModuleImportIncomingSnapshot = {
          id: built.package.id,
          name: built.package.name,
          contentHash: built.contentHash,
          packagePath: path.resolve(packagePath),
        };
        const local = await this.readLocalModuleSnapshot(built.package.id);
        if (!local) {
          return { status: 'create', incoming };
        }
        if (local.contentHash === built.contentHash) {
          return { status: 'identical', local, incoming };
        }
        return { status: 'conflict', local, incoming };
      } finally {
        await fs.rm(stagingPath, { recursive: true, force: true });
      }
    });
  }

  /**
   * Import a portable knowledge module package.
   * Conflict resolution is required when the stable id exists with a different content hash.
   */
  importKnowledgeModule(
    packagePath: string,
    conflictResolution?: ModuleImportConflictResolution,
  ): Promise<ModuleImportResult> {
    return this.runExclusive(async () => {
      const stagingPath = path.join(this.rootPath, `.tmp-import-${randomUUID()}`);
      try {
        const built = await loadAndValidateKnowledgeModulePackage(packagePath, stagingPath);
        const local = await this.readLocalModuleSnapshot(built.package.id);

        if (!local) {
          const created = await this.materializeImportedModule(built, built.package.id);
          return {
            status: 'created',
            id: created.id,
            revision: created.revision,
            contentHash: created.contentHash,
          };
        }

        if (local.contentHash === built.contentHash) {
          return {
            status: 'identical',
            id: local.id,
            revision: local.revision,
            contentHash: local.contentHash,
          };
        }

        if (!conflictResolution) {
          throw new ModulePackageError(
            'Import conflict requires an explicit resolution: keep-local, use-imported, or import-as-copy'
          );
        }

        if (conflictResolution === 'keep-local') {
          return {
            status: 'kept-local',
            id: local.id,
            revision: local.revision,
            contentHash: local.contentHash,
          };
        }

        if (conflictResolution === 'use-imported') {
          const updated = await this.applyImportedRevision(built, local.id);
          return {
            status: 'updated',
            id: updated.id,
            revision: updated.revision,
            contentHash: updated.contentHash,
          };
        }

        const newId = randomUUID();
        const rewritten = rewritePackageStableId(built, newId);
        // Re-stage rewritten SPACE.md and recompute the authoritative content hash.
        const copyStaging = path.join(this.rootPath, `.tmp-import-copy-${randomUUID()}`);
        try {
          await fs.mkdir(copyStaging, { recursive: true });
          for (const file of rewritten.package.files) {
            const targetPath = path.join(copyStaging, ...file.relative_path.split('/'));
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, file.content, 'utf8');
          }
          const loaded = await loadSpaceObject(copyStaging);
          const copyBuilt = buildKnowledgeModulePackage({
            files: rewritten.package.files.map((file) => ({
              relativePath: file.relative_path,
              content: file.content,
            })),
            contentHash: loaded.contentHash,
            exportedAt: rewritten.package.exported_at,
          });
          const created = await this.materializeImportedModule(copyBuilt, newId);
          return {
            status: 'copied',
            id: created.id,
            sourceId: local.id,
            revision: created.revision,
            contentHash: created.contentHash,
          };
        } finally {
          await fs.rm(copyStaging, { recursive: true, force: true });
        }
      } finally {
        await fs.rm(stagingPath, { recursive: true, force: true });
      }
    });
  }

  private async resolvePublishedObjectUnlocked(
    id: string,
    revision?: number,
  ): Promise<PublishedObjectRoot | undefined> {
    try {
      const manifest = await this.readManifest(id);
      if (!manifest.latestRevision) return undefined;
      const targetRevision = revision ?? manifest.latestRevision;
      if (!Number.isInteger(targetRevision) || targetRevision < 1) return undefined;
      if (targetRevision > manifest.latestRevision) return undefined;
      const loaded = await this.readRevisionIfExists(id, targetRevision);
      if (!loaded) return undefined;
      const document = parseSpaceDocument(loaded.source);
      this.assertManagedIdentity(manifest, document);
      const metadata = document.metadata;
      return {
        id: metadata.id,
        name: metadata.name,
        kind: metadata.kind,
        revision: loaded.revision,
        contentHash: loaded.contentHash,
        rootPath: this.revisionPath(id, loaded.revision),
        guidanceFiles: metadata.kind === 'knowledge'
          ? [...(metadata.guidance_files ?? [])]
          : [],
        alwaysModuleIds: metadata.kind === 'environment'
          ? [...metadata.modules.always]
          : [],
      };
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async classifyEnvironmentImport(
    built: BuiltEnvironmentPackage,
    packagePath: string,
  ): Promise<EnvironmentImportPreview> {
    const referenced = environmentReferencedModuleIds(built.environment.document);
    const associationById = new Map<string, 'always' | 'on_demand'>();
    for (const id of referenced.always) associationById.set(id, 'always');
    for (const id of referenced.onDemand) associationById.set(id, 'on_demand');

    const envLocal = await this.readLocalEnvironmentSnapshot(built.environment.payload.id);
    const envIncoming: EnvironmentImportObjectSnapshot = {
      id: built.environment.payload.id,
      name: built.environment.payload.name,
      contentHash: built.environment.contentHash,
    };
    let environmentStatus: Exclude<EnvironmentImportObjectStatus, 'missing'>;
    if (!envLocal) {
      environmentStatus = 'create';
    } else if (envLocal.contentHash === built.environment.contentHash) {
      environmentStatus = 'identical';
    } else {
      environmentStatus = 'conflict';
    }

    const embeddedById = new Map(
      built.modules.map((module) => [module.package.id, module] as const),
    );
    const modules: EnvironmentImportModulePreview[] = [];
    for (const moduleId of referenced.all) {
      const association = associationById.get(moduleId);
      const embedded = embeddedById.get(moduleId);
      if (!embedded) {
        // Not in package: keep as missing/unresolved; do not invent substitutes.
        const local = await this.readLocalModuleSnapshot(moduleId);
        modules.push({
          id: moduleId,
          association,
          status: local ? 'identical' : 'missing',
          local: local
            ? {
              id: local.id,
              name: local.name,
              contentHash: local.contentHash,
              revision: local.revision,
            }
            : undefined,
        });
        continue;
      }

      const local = await this.readLocalModuleSnapshot(moduleId);
      const incoming: EnvironmentImportObjectSnapshot = {
        id: embedded.package.id,
        name: embedded.package.name,
        contentHash: embedded.contentHash,
      };
      if (!local) {
        modules.push({ id: moduleId, association, status: 'create', incoming });
      } else if (local.contentHash === embedded.contentHash) {
        modules.push({
          id: moduleId,
          association,
          status: 'identical',
          local: {
            id: local.id,
            name: local.name,
            contentHash: local.contentHash,
            revision: local.revision,
          },
          incoming,
        });
      } else {
        modules.push({
          id: moduleId,
          association,
          status: 'conflict',
          local: {
            id: local.id,
            name: local.name,
            contentHash: local.contentHash,
            revision: local.revision,
          },
          incoming,
        });
      }
    }

    const unresolvedModuleIds = modules
      .filter((module) => module.status === 'missing')
      .map((module) => module.id);

    return {
      packageKind: built.package.package_kind,
      packagePath: path.resolve(packagePath),
      environment: {
        status: environmentStatus,
        local: envLocal
          ? {
            id: envLocal.id,
            name: envLocal.name,
            contentHash: envLocal.contentHash,
            revision: envLocal.revision,
          }
          : undefined,
        incoming: envIncoming,
      },
      modules,
      unresolvedModuleIds,
    };
  }

  private assertEnvironmentImportResolutions(
    preview: EnvironmentImportPreview,
    resolutions: EnvironmentImportResolutions,
  ): void {
    if (preview.environment.status === 'conflict' && !resolutions.environmentResolution) {
      throw new EnvironmentPackageError(
        'Environment import conflict requires an explicit resolution: keep-local, use-imported, or import-as-copy',
      );
    }
    for (const module of preview.modules) {
      if (module.status === 'conflict' && !resolutions.moduleResolutions?.[module.id]) {
        throw new EnvironmentPackageError(
          `Module import conflict for ${module.id} requires an explicit resolution: keep-local, use-imported, or import-as-copy`,
        );
      }
    }
  }

  private async assertImportTargetsWritable(
    preview: EnvironmentImportPreview,
  ): Promise<void> {
    if (preview.environment.status === 'create') {
      await this.assertObjectPathAvailable(preview.environment.incoming.id, 'environment');
    }
    for (const module of preview.modules) {
      if (module.status === 'create') {
        await this.assertObjectPathAvailable(module.id, 'knowledge module');
      }
    }
  }

  private async assertObjectPathAvailable(
    id: string,
    kindLabel: string,
  ): Promise<void> {
    try {
      await fs.access(this.objectPath(id));
      throw new EnvironmentPackageError(
        `Cannot import ${kindLabel}: stable id already exists without a matching published revision: ${id}`,
      );
    } catch (error) {
      if (error instanceof EnvironmentPackageError) throw error;
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }

  private async applyModuleImportDecision(
    built: BuiltKnowledgeModulePackage,
    preview: EnvironmentImportModulePreview,
    resolution: ModuleImportConflictResolution | undefined,
    rollbackLog: EnvironmentImportRollbackEntry[],
  ): Promise<ModuleImportResult> {
    if (preview.status === 'create') {
      const created = await this.materializeImportedModule(built, built.package.id);
      rollbackLog.push({ kind: 'created', id: created.id });
      return {
        status: 'created',
        id: created.id,
        revision: created.revision,
        contentHash: created.contentHash,
      };
    }

    if (preview.status === 'identical') {
      const local = preview.local!;
      return {
        status: 'identical',
        id: local.id,
        revision: local.revision ?? 1,
        contentHash: local.contentHash,
      };
    }

    if (preview.status !== 'conflict') {
      throw new EnvironmentPackageError(`Unexpected module import status: ${preview.status}`);
    }
    if (!resolution) {
      throw new EnvironmentPackageError(
        'Import conflict requires an explicit resolution: keep-local, use-imported, or import-as-copy',
      );
    }
    if (resolution === 'keep-local') {
      const local = preview.local!;
      return {
        status: 'kept-local',
        id: local.id,
        revision: local.revision ?? 1,
        contentHash: local.contentHash,
      };
    }
    if (resolution === 'use-imported') {
      const snapshot = await this.captureObjectImportSnapshot(built.package.id);
      const updated = await this.applyImportedRevision(built, built.package.id);
      rollbackLog.push({
        kind: 'revision',
        id: updated.id,
        revision: updated.revision,
        snapshot,
      });
      return {
        status: 'updated',
        id: updated.id,
        revision: updated.revision,
        contentHash: updated.contentHash,
      };
    }

    const newId = randomUUID();
    const rewritten = rewritePackageStableId(built, newId);
    const copyStaging = path.join(this.rootPath, `.tmp-import-env-module-copy-${randomUUID()}`);
    try {
      await fs.mkdir(copyStaging, { recursive: true });
      for (const file of rewritten.package.files) {
        const targetPath = path.join(copyStaging, ...file.relative_path.split('/'));
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, file.content, 'utf8');
      }
      const loaded = await loadSpaceObject(copyStaging);
      const copyBuilt = buildKnowledgeModulePackage({
        files: rewritten.package.files.map((file) => ({
          relativePath: file.relative_path,
          content: file.content,
        })),
        contentHash: loaded.contentHash,
        exportedAt: rewritten.package.exported_at,
      });
      const created = await this.materializeImportedModule(copyBuilt, newId);
      rollbackLog.push({ kind: 'created', id: created.id });
      return {
        status: 'copied',
        id: created.id,
        sourceId: preview.local!.id,
        revision: created.revision,
        contentHash: created.contentHash,
      };
    } finally {
      await fs.rm(copyStaging, { recursive: true, force: true });
    }
  }

  private async applyEnvironmentImportDecision(
    built: BuiltEnvironmentObject,
    preview: EnvironmentImportPreview['environment'],
    resolution: ModuleImportConflictResolution | undefined,
    rollbackLog: EnvironmentImportRollbackEntry[],
  ): Promise<ModuleImportResult> {
    if (preview.status === 'create') {
      const created = await this.materializeImportedEnvironment(built, built.payload.id);
      rollbackLog.push({ kind: 'created', id: created.id });
      return {
        status: 'created',
        id: created.id,
        revision: created.revision,
        contentHash: created.contentHash,
      };
    }

    if (preview.status === 'identical') {
      // Association remaps after module import-as-copy change the environment hash.
      // When associations were rewritten, treat as an update path below if hashes differ.
      if (preview.local && preview.local.contentHash === built.contentHash) {
        return {
          status: 'identical',
          id: preview.local.id,
          revision: preview.local.revision ?? 1,
          contentHash: preview.local.contentHash,
        };
      }
      // Hash diverged because module IDs were remapped for copies.
      const snapshot = await this.captureObjectImportSnapshot(built.payload.id);
      const updated = await this.applyImportedEnvironmentRevision(built, built.payload.id);
      rollbackLog.push({
        kind: 'revision',
        id: updated.id,
        revision: updated.revision,
        snapshot,
      });
      return {
        status: 'updated',
        id: updated.id,
        revision: updated.revision,
        contentHash: updated.contentHash,
      };
    }

    if (preview.status !== 'conflict') {
      throw new EnvironmentPackageError(`Unexpected environment import status: ${preview.status}`);
    }
    if (!resolution) {
      throw new EnvironmentPackageError(
        'Environment import conflict requires an explicit resolution: keep-local, use-imported, or import-as-copy',
      );
    }
    if (resolution === 'keep-local') {
      const local = preview.local!;
      return {
        status: 'kept-local',
        id: local.id,
        revision: local.revision ?? 1,
        contentHash: local.contentHash,
      };
    }
    if (resolution === 'use-imported') {
      const snapshot = await this.captureObjectImportSnapshot(built.payload.id);
      const updated = await this.applyImportedEnvironmentRevision(built, built.payload.id);
      rollbackLog.push({
        kind: 'revision',
        id: updated.id,
        revision: updated.revision,
        snapshot,
      });
      return {
        status: 'updated',
        id: updated.id,
        revision: updated.revision,
        contentHash: updated.contentHash,
      };
    }

    const newId = randomUUID();
    let rewritten = rewriteEnvironmentStableId(built, newId);
    const copyStaging = path.join(this.rootPath, `.tmp-import-env-copy-${randomUUID()}`);
    try {
      await fs.mkdir(copyStaging, { recursive: true });
      for (const file of rewritten.payload.files) {
        const targetPath = path.join(copyStaging, ...file.relative_path.split('/'));
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, file.content, 'utf8');
      }
      const loaded = await loadSpaceObject(copyStaging);
      rewritten = buildEnvironmentObjectPackage({
        files: rewritten.payload.files.map((file) => ({
          relativePath: file.relative_path,
          content: file.content,
        })),
        contentHash: loaded.contentHash,
      });
      const created = await this.materializeImportedEnvironment(rewritten, newId);
      rollbackLog.push({ kind: 'created', id: created.id });
      return {
        status: 'copied',
        id: created.id,
        sourceId: preview.local!.id,
        revision: created.revision,
        contentHash: created.contentHash,
      };
    } finally {
      await fs.rm(copyStaging, { recursive: true, force: true });
    }
  }

  private async captureObjectImportSnapshot(
    id: string,
  ): Promise<EnvironmentImportObjectStateSnapshot> {
    const manifest = await this.readManifest(id);
    const draft = await this.readDraft(id);
    let fileOrigins: string | undefined;
    try {
      fileOrigins = await fs.readFile(this.fileOriginsPath(id), 'utf8');
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    let draftFilesBackup: string | undefined;
    const draftFilesPath = this.draftFilesPath(id);
    try {
      await fs.access(draftFilesPath);
      draftFilesBackup = path.join(this.rootPath, `.tmp-import-rollback-drafts-${randomUUID()}`);
      await fs.cp(draftFilesPath, draftFilesBackup, { recursive: true });
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    return {
      manifest,
      draft,
      fileOrigins,
      draftFilesBackup,
    };
  }

  private async rollbackEnvironmentImport(
    rollbackLog: readonly EnvironmentImportRollbackEntry[],
  ): Promise<void> {
    for (const entry of [...rollbackLog].reverse()) {
      try {
        if (entry.kind === 'created') {
          await fs.rm(this.objectPath(entry.id), { recursive: true, force: true });
          continue;
        }
        await fs.rm(this.revisionPath(entry.id, entry.revision), {
          recursive: true,
          force: true,
        });
        await this.writeJsonAtomic(this.manifestPath(entry.id), entry.snapshot.manifest);
        await this.writeJsonAtomic(this.draftPath(entry.id), entry.snapshot.draft);
        if (entry.snapshot.fileOrigins !== undefined) {
          await fs.writeFile(this.fileOriginsPath(entry.id), entry.snapshot.fileOrigins, 'utf8');
        } else {
          await fs.rm(this.fileOriginsPath(entry.id), { force: true });
        }
        await fs.rm(this.draftFilesPath(entry.id), { recursive: true, force: true });
        if (entry.snapshot.draftFilesBackup) {
          await fs.cp(entry.snapshot.draftFilesBackup, this.draftFilesPath(entry.id), {
            recursive: true,
          });
          await fs.rm(entry.snapshot.draftFilesBackup, { recursive: true, force: true });
        } else {
          await fs.mkdir(this.draftFilesPath(entry.id), { recursive: true });
        }
      } catch {
        // Best-effort rollback; surface the original import error to the caller.
      }
    }
  }

  private async materializeImportedEnvironment(
    built: BuiltEnvironmentObject,
    id: string,
  ): Promise<SpaceRevision> {
    if (built.document.metadata.kind !== 'environment') {
      throw new EnvironmentPackageError('Imported package is not an environment profile');
    }
    if (built.document.metadata.id !== id) {
      throw new EnvironmentPackageError(
        'Imported package stable id does not match materialization id',
      );
    }
    assertSafeId(id);
    const objectPath = this.objectPath(id);
    try {
      await fs.access(objectPath);
      throw new EnvironmentPackageError(`Environment already exists: ${id}`);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') && !(error instanceof EnvironmentPackageError)) {
        throw error;
      }
      if (error instanceof EnvironmentPackageError) throw error;
    }

    const createdAt = new Date().toISOString();
    const source = serializeSpaceDocument(built.document);
    const form = toEnvironmentForm(built.document);
    const temporaryPath = path.join(this.rootPath, `.tmp-${randomUUID()}`);
    const revision: SpaceRevision = {
      id,
      revision: 1,
      contentHash: built.contentHash,
      createdAt,
      source,
    };

    try {
      await fs.mkdir(path.join(temporaryPath, 'revisions', '00000001'), { recursive: true });
      await fs.mkdir(path.join(temporaryPath, 'draft-files'), { recursive: true });

      const revisionRoot = path.join(temporaryPath, 'revisions', '00000001');
      for (const file of built.payload.files) {
        const relativePath = file.relative_path;
        const revisionTarget = path.join(revisionRoot, ...relativePath.split('/'));
        await fs.mkdir(path.dirname(revisionTarget), { recursive: true });
        await fs.writeFile(revisionTarget, file.content, 'utf8');
        if (relativePath !== 'SPACE.md') {
          const draftTarget = path.join(temporaryPath, 'draft-files', ...relativePath.split('/'));
          await fs.mkdir(path.dirname(draftTarget), { recursive: true });
          await fs.writeFile(draftTarget, file.content, 'utf8');
        }
      }

      const loaded = await loadSpaceObject(revisionRoot);
      if (loaded.contentHash !== built.contentHash) {
        throw new EnvironmentPackageError(
          `Imported content hash mismatch after materialization: expected ${built.contentHash}, got ${loaded.contentHash}`,
        );
      }

      await fs.writeFile(
        path.join(revisionRoot, 'revision.json'),
        `${JSON.stringify(revision, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );

      const manifest: StoredManifest = {
        id,
        kind: 'environment',
        createdAt,
        latestRevision: 1,
        draftSummary: environmentSummaryFromDocument(built.document),
      };
      const draft: DraftRecord = {
        source,
        savedAt: createdAt,
        form,
      };
      await this.writeJsonAtomic(path.join(temporaryPath, 'manifest.json'), manifest);
      await this.writeJsonAtomic(path.join(temporaryPath, 'draft.json'), draft);
      await fs.rename(temporaryPath, objectPath);
      return revision;
    } catch (error) {
      await fs.rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async applyImportedEnvironmentRevision(
    built: BuiltEnvironmentObject,
    id: string,
  ): Promise<SpaceRevision> {
    const manifest = await this.readManifest(id);
    if (manifestKind(manifest) !== 'environment') {
      throw new EnvironmentPackageError('Local object is not an environment profile');
    }
    if (built.document.metadata.id !== id) {
      throw new EnvironmentPackageError(
        'Imported package stable id does not match local environment',
      );
    }

    const revisionNumber = (manifest.latestRevision ?? 0) + 1;
    const createdAt = new Date().toISOString();
    const source = serializeSpaceDocument(built.document);
    const revisionsPath = path.join(this.objectPath(id), 'revisions');
    const finalPath = this.revisionPath(id, revisionNumber);
    const temporaryPath = path.join(revisionsPath, `.tmp-${randomUUID()}`);
    let renamed = false;
    let manifestUpdated = false;

    try {
      await fs.mkdir(temporaryPath, { recursive: true });
      for (const file of built.payload.files) {
        const targetPath = path.join(temporaryPath, ...file.relative_path.split('/'));
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, file.content, 'utf8');
      }
      const loaded = await loadSpaceObject(temporaryPath);
      if (loaded.contentHash !== built.contentHash) {
        throw new EnvironmentPackageError(
          `Imported content hash mismatch: expected ${built.contentHash}, got ${loaded.contentHash}`,
        );
      }
      const result: SpaceRevision = {
        id,
        revision: revisionNumber,
        contentHash: loaded.contentHash,
        createdAt,
        source,
      };
      await fs.writeFile(
        path.join(temporaryPath, 'revision.json'),
        `${JSON.stringify(result, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );

      await fs.rename(temporaryPath, finalPath);
      renamed = true;
      await this.writeJsonAtomic(this.manifestPath(id), {
        ...manifest,
        latestRevision: revisionNumber,
        draftSummary: environmentSummaryFromDocument(built.document),
      });
      manifestUpdated = true;

      await fs.rm(this.fileOriginsPath(id), { force: true });
      await fs.rm(this.draftFilesPath(id), { recursive: true, force: true });
      await fs.mkdir(this.draftFilesPath(id), { recursive: true });
      for (const file of built.payload.files) {
        if (file.relative_path === 'SPACE.md') continue;
        const draftTarget = path.join(this.draftFilesPath(id), ...file.relative_path.split('/'));
        await fs.mkdir(path.dirname(draftTarget), { recursive: true });
        await fs.writeFile(draftTarget, file.content, 'utf8');
      }
      await this.writeDraft(id, source, toEnvironmentForm(built.document));
      return result;
    } catch (error) {
      await fs.rm(temporaryPath, { recursive: true, force: true });
      if (renamed && !manifestUpdated) {
        await fs.rm(finalPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async readLocalEnvironmentSnapshot(
    id: string,
  ): Promise<ModuleImportLocalSnapshot | undefined> {
    try {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'environment' || !manifest.latestRevision) {
        return undefined;
      }
      const revision = await this.readRevisionIfExists(id, manifest.latestRevision);
      if (!revision) return undefined;
      const document = parseSpaceDocument(revision.source);
      return {
        id: revision.id,
        name: document.metadata.name,
        revision: revision.revision,
        contentHash: revision.contentHash,
      };
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async previewExportModuleDependency(
    id: string,
    association: 'always' | 'on_demand',
  ): Promise<EnvironmentExportModulePreview> {
    try {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'knowledge' || !manifest.latestRevision) {
        return { id, association, status: 'unresolved' };
      }
      const revision = await this.readRevisionIfExists(id, manifest.latestRevision);
      if (!revision) {
        return { id, association, status: 'unresolved' };
      }
      const document = parseSpaceDocument(revision.source);
      if (document.metadata.kind !== 'knowledge') {
        return { id, association, status: 'unresolved' };
      }
      return {
        id,
        name: document.metadata.name,
        association,
        status: 'resolved',
        revision: revision.revision,
        contentHash: revision.contentHash,
      };
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return { id, association, status: 'unresolved' };
      }
      throw error;
    }
  }

  private async readLocalModuleSnapshot(
    id: string,
  ): Promise<ModuleImportLocalSnapshot | undefined> {
    try {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'knowledge' || !manifest.latestRevision) {
        return undefined;
      }
      const revision = await this.readRevisionIfExists(id, manifest.latestRevision);
      if (!revision) return undefined;
      const document = parseSpaceDocument(revision.source);
      return {
        id: revision.id,
        name: document.metadata.name,
        revision: revision.revision,
        contentHash: revision.contentHash,
      };
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  /**
   * Create a normal managed object plus initial valid revision from a validated package.
   * Uses temp-dir + rename so failures leave no half-object.
   */
  private async materializeImportedModule(
    built: BuiltKnowledgeModulePackage,
    id: string,
  ): Promise<SpaceRevision> {
    if (built.document.metadata.kind !== 'knowledge') {
      throw new ModulePackageError('Imported package is not a knowledge module');
    }
    if (built.document.metadata.id !== id) {
      throw new ModulePackageError('Imported package stable id does not match materialization id');
    }
    assertSafeId(id);
    const objectPath = this.objectPath(id);
    try {
      await fs.access(objectPath);
      throw new ModulePackageError(`Knowledge module already exists: ${id}`);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') && !(error instanceof ModulePackageError)) {
        throw error;
      }
      if (error instanceof ModulePackageError) throw error;
    }

    const createdAt = new Date().toISOString();
    const source = serializeSpaceDocument(built.document);
    const form = toKnowledgeForm(built.document);
    const temporaryPath = path.join(this.rootPath, `.tmp-${randomUUID()}`);
    const revision: SpaceRevision = {
      id,
      revision: 1,
      contentHash: built.contentHash,
      createdAt,
      source,
    };

    try {
      await fs.mkdir(path.join(temporaryPath, 'revisions', '00000001'), { recursive: true });
      await fs.mkdir(path.join(temporaryPath, 'draft-files'), { recursive: true });

      const revisionRoot = path.join(temporaryPath, 'revisions', '00000001');
      for (const file of built.package.files) {
        const relativePath = file.relative_path;
        const revisionTarget = path.join(revisionRoot, ...relativePath.split('/'));
        await fs.mkdir(path.dirname(revisionTarget), { recursive: true });
        await fs.writeFile(revisionTarget, file.content, 'utf8');
        if (relativePath !== 'SPACE.md') {
          const draftTarget = path.join(temporaryPath, 'draft-files', ...relativePath.split('/'));
          await fs.mkdir(path.dirname(draftTarget), { recursive: true });
          await fs.writeFile(draftTarget, file.content, 'utf8');
        }
      }

      // Confirm staged revision root still matches package hash.
      const loaded = await loadSpaceObject(revisionRoot);
      if (loaded.contentHash !== built.contentHash) {
        throw new ModulePackageError(
          `Imported content hash mismatch after materialization: expected ${built.contentHash}, got ${loaded.contentHash}`
        );
      }

      await fs.writeFile(
        path.join(revisionRoot, 'revision.json'),
        `${JSON.stringify(revision, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );

      const manifest: StoredManifest = {
        id,
        kind: 'knowledge',
        createdAt,
        latestRevision: 1,
        draftSummary: summaryFromDocument(built.document),
      };
      const draft: DraftRecord = {
        source,
        savedAt: createdAt,
        form,
      };
      await this.writeJsonAtomic(path.join(temporaryPath, 'manifest.json'), manifest);
      await this.writeJsonAtomic(path.join(temporaryPath, 'draft.json'), draft);
      await fs.rename(temporaryPath, objectPath);
      return revision;
    } catch (error) {
      await fs.rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
  }

  /** Append imported content as the next valid revision of an existing module. */
  private async applyImportedRevision(
    built: BuiltKnowledgeModulePackage,
    id: string,
  ): Promise<SpaceRevision> {
    const manifest = await this.readManifest(id);
    if (manifestKind(manifest) !== 'knowledge') {
      throw new ModulePackageError('Local object is not a knowledge module');
    }
    if (built.document.metadata.id !== id) {
      throw new ModulePackageError('Imported package stable id does not match local module');
    }

    const revisionNumber = (manifest.latestRevision ?? 0) + 1;
    const createdAt = new Date().toISOString();
    const source = serializeSpaceDocument(built.document);
    const revisionsPath = path.join(this.objectPath(id), 'revisions');
    const finalPath = this.revisionPath(id, revisionNumber);
    const temporaryPath = path.join(revisionsPath, `.tmp-${randomUUID()}`);
    let renamed = false;
    let manifestUpdated = false;

    try {
      await fs.mkdir(temporaryPath, { recursive: true });
      for (const file of built.package.files) {
        const targetPath = path.join(temporaryPath, ...file.relative_path.split('/'));
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, file.content, 'utf8');
      }
      const loaded = await loadSpaceObject(temporaryPath);
      if (loaded.contentHash !== built.contentHash) {
        throw new ModulePackageError(
          `Imported content hash mismatch: expected ${built.contentHash}, got ${loaded.contentHash}`
        );
      }
      const result: SpaceRevision = {
        id,
        revision: revisionNumber,
        contentHash: loaded.contentHash,
        createdAt,
        source,
      };
      await fs.writeFile(
        path.join(temporaryPath, 'revision.json'),
        `${JSON.stringify(result, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );

      // Commit the immutable revision first so failures never leave a half-applied draft.
      await fs.rename(temporaryPath, finalPath);
      renamed = true;
      await this.writeJsonAtomic(this.manifestPath(id), {
        ...manifest,
        latestRevision: revisionNumber,
        draftSummary: summaryFromDocument(built.document),
      });
      manifestUpdated = true;

      // Portable import replaces managed snapshots; drop local absolute source origins.
      await fs.rm(this.fileOriginsPath(id), { force: true });
      await fs.rm(this.draftFilesPath(id), { recursive: true, force: true });
      await fs.mkdir(this.draftFilesPath(id), { recursive: true });
      for (const file of built.package.files) {
        if (file.relative_path === 'SPACE.md') continue;
        const draftTarget = path.join(this.draftFilesPath(id), ...file.relative_path.split('/'));
        await fs.mkdir(path.dirname(draftTarget), { recursive: true });
        await fs.writeFile(draftTarget, file.content, 'utf8');
      }
      await this.writeDraft(id, source, toKnowledgeForm(built.document));
      return result;
    } catch (error) {
      await fs.rm(temporaryPath, { recursive: true, force: true });
      if (renamed && !manifestUpdated) {
        // Revision directory was published but the latest pointer never advanced.
        await fs.rm(finalPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async publishObjectDraft(
    id: string,
    expectedKind: 'environment' | 'knowledge',
    options: { origin?: string } = {},
  ): Promise<SpaceRevision> {
    return this.publishObjectDraftUnlocked(id, expectedKind, options);
  }

  private async publishObjectDraftUnlocked(
    id: string,
    expectedKind: 'environment' | 'knowledge',
    options: { origin?: string; skipSecretScan?: boolean; allowExternalPending?: boolean } = {},
  ): Promise<SpaceRevision> {
    const manifest = await this.readManifest(id);
    if (manifestKind(manifest) !== expectedKind) {
      throw new Error(`Requested object is not a ${expectedKind} profile`);
    }
    if (!options.allowExternalPending) {
      const external = await this.scanExternalChangesUnlocked(id);
      if (external.hasPendingExternalChanges) {
        throw new Error(
          'External changes are pending. Adopt or restore them before publishing a revision from the app editor.',
        );
      }
    }
    const draft = await this.readDraft(id);
    const document = parseSpaceDocument(draft.source);
    this.assertManagedIdentity(manifest, document);
    if (document.metadata.kind !== expectedKind) {
      throw new Error(`Draft must use kind: ${expectedKind}`);
    }
    const managedPaths = await this.listManagedDraftRelativePaths(id);
    if (
      document.metadata.kind === 'knowledge'
      && (document.metadata.guidance_files?.length ?? 0) > 0
      && managedPaths.length === 0
    ) {
      throw new Error('Single-file knowledge modules cannot reference guidance_files');
    }

    const source = serializeSpaceDocument(document);
    const managedFiles: Array<{ relativePath: string; content: string }> = [];
    for (const relativePath of managedPaths) {
      managedFiles.push({
        relativePath,
        content: await this.readManagedDraftFile(id, relativePath),
      });
    }

    if (!options.skipSecretScan) {
      const scan = scanKnowledgeSecrets(draft.source);
      if (scan.status !== 'clean') {
        const finding = scan.findings[0];
        throw new Error(
          `Draft contains a possible secret (${finding?.ruleId ?? 'unknown'} at line ${finding?.line ?? 1})`
        );
      }
      for (const file of managedFiles) {
        const fileScan = scanKnowledgeSecrets(file.content);
        if (fileScan.status !== 'clean') {
          const finding = fileScan.findings[0];
          throw new Error(
            `Managed file contains a possible secret (${finding?.ruleId ?? 'unknown'} at ${file.relativePath}:${finding?.line ?? 1})`
          );
        }
      }
    }

    const estimatedWriteBytes = Buffer.byteLength(source, 'utf8')
      + managedFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0)
      + 4096;
    await this.assertDiskSpaceForRevision(estimatedWriteBytes);

    const revision = (manifest.latestRevision ?? 0) + 1;
    const createdAt = new Date().toISOString();
    const origin = normalizeRevisionOrigin(options.origin ?? publishOrigin());
    const revisionsPath = path.join(this.objectPath(id), 'revisions');
    const finalPath = this.revisionPath(id, revision);
    const orphanedRevision = await this.readRevisionIfExists(id, revision);
    if (orphanedRevision) {
      if (orphanedRevision.source === source && managedPaths.length === 0) {
        await this.writeJsonAtomic(this.manifestPath(id), {
          ...manifest,
          latestRevision: revision,
        });
        return orphanedRevision;
      }
      await fs.rm(finalPath, { recursive: true, force: true });
    }

    const temporaryPath = path.join(revisionsPath, `.tmp-${randomUUID()}`);
    await fs.mkdir(temporaryPath, { recursive: true });
    try {
      const fileMap = await this.materializeRevisionFiles(id, temporaryPath, [
        { relativePath: 'SPACE.md', content: source },
        ...managedFiles,
      ]);
      // Exclude system metadata from the hashed object root.
      const loaded = await loadSpaceObject(temporaryPath);
      const result: SpaceRevision = {
        id,
        revision,
        contentHash: loaded.contentHash,
        createdAt,
        source,
        origin,
        files: fileMap,
      };
      await fs.writeFile(
        path.join(temporaryPath, 'revision.json'),
        `${JSON.stringify(result, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
      await fs.rename(temporaryPath, finalPath);
      await this.writeJsonAtomic(this.manifestPath(id), {
        ...manifest,
        latestRevision: revision,
      });
      // Baseline tracks what the app intentionally published, not arbitrary disk noise.
      await this.writeExternalBaseline(id, {
        'SPACE.md': contentSha256(source),
        ...Object.fromEntries(
          managedFiles.map((file) => [file.relativePath, contentSha256(file.content)]),
        ),
      });
      // Keep SPACE.md on disk aligned with the published entry source.
      await this.writeWorkingSpaceFile(id, source);
      return result;
    } catch (error) {
      await fs.rm(temporaryPath, { recursive: true, force: true });
      if (isNodeError(error, 'ENOSPC')) {
        throw new Error(
          'Insufficient disk space to create a new knowledge revision. '
          + 'Free space or explicitly clean up old revisions before saving.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async loadModule(id: string): Promise<KnowledgeModuleDetail> {
    const manifest = await this.readManifest(id);
    if (manifestKind(manifest) !== 'knowledge') {
      throw new Error('Requested object is not a knowledge module');
    }
    const draft = await this.readDraft(id);
    // Prefer the stored form draft when present so form-mode edits are not rewritten by
    // SPACE.md serialize/parse (e.g. forced trailing newlines) on every autosave.
    let form: KnowledgeModuleFormDraft | undefined = isKnowledgeForm(draft.form)
      ? draft.form
      : undefined;
    let summary = {
      ...manifest.draftSummary,
      whenToUse: manifest.draftSummary.whenToUse ?? '',
    };
    let draftValidationError: string | undefined;
    try {
      const document = parseSpaceDocument(draft.source);
      this.assertManagedIdentity(manifest, document);
      if (!form) form = toKnowledgeForm(document);
      summary = summaryFromDocument(document);
    } catch (error) {
      draftValidationError = errorMessage(error);
    }
    let latestContentHash: string | undefined;
    if (manifest.latestRevision) {
      const revision = await this.readRevision(id, manifest.latestRevision);
      latestContentHash = revision.contentHash;
    }
    return {
      id,
      ...summary,
      draftSavedAt: draft.savedAt,
      latestRevision: manifest.latestRevision,
      latestContentHash,
      source: draft.source,
      form,
      draftValidationError,
    };
  }

  private async resolveModuleAssociations(
    ids: readonly string[]
  ): Promise<EnvironmentModuleDependency[]> {
    const dependencies: EnvironmentModuleDependency[] = [];
    for (const id of ids) {
      try {
        const manifest = await this.readManifest(id);
        if (manifestKind(manifest) !== 'knowledge') {
          dependencies.push({ id, status: 'unresolved' });
          continue;
        }
        dependencies.push({
          id,
          name: manifest.draftSummary.name,
          status: 'resolved',
        });
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
        dependencies.push({ id, status: 'unresolved' });
      }
    }
    return dependencies;
  }

  private async loadEnvironment(id: string): Promise<EnvironmentDetail> {
    const manifest = await this.readManifest(id);
    if (manifestKind(manifest) !== 'environment') {
      throw new Error('Requested object is not an environment profile');
    }
    const draft = await this.readDraft(id);
    // Prefer the stored form draft when present so form-mode edits are not rewritten by
    // SPACE.md serialize/parse (e.g. forced trailing newlines) on every autosave.
    let form: EnvironmentFormDraft | undefined = isEnvironmentForm(draft.form)
      ? draft.form
      : undefined;
    let summary = manifest.draftSummary;
    let draftValidationError: string | undefined;
    try {
      const document = parseSpaceDocument(draft.source);
      this.assertManagedIdentity(manifest, document);
      if (!form) form = toEnvironmentForm(document);
      summary = environmentSummaryFromDocument(document);
    } catch (error) {
      draftValidationError = errorMessage(error);
    }
    let latestContentHash: string | undefined;
    if (manifest.latestRevision) {
      const revision = await this.readRevision(id, manifest.latestRevision);
      latestContentHash = revision.contentHash;
    }
    const associations = {
      always: await this.resolveModuleAssociations(form?.always ?? []),
      onDemand: await this.resolveModuleAssociations(form?.onDemand ?? []),
    };
    return {
      id,
      name: summary.name,
      description: summary.description,
      tags: summary.tags,
      draftSavedAt: draft.savedAt,
      latestRevision: manifest.latestRevision,
      latestContentHash,
      source: draft.source,
      form,
      associations,
      draftValidationError,
    };
  }

  private async loadPublishedEnvironmentSummary(
    manifest: StoredManifest
  ): Promise<PublishedEnvironmentSummary> {
    const revision = await this.readRevision(manifest.id, manifest.latestRevision!);
    const document = parseSpaceDocument(revision.source);
    const metadata = document.metadata;
    if (metadata.kind !== 'environment') throw new Error('Published object is not an environment');
    return {
      id: manifest.id,
      name: metadata.name,
      description: metadata.description,
      tags: metadata.tags ?? [],
      always: metadata.modules.always,
      onDemand: metadata.modules.on_demand,
      revision: revision.revision,
      contentHash: revision.contentHash,
    };
  }

  private async listPublishedModules(
    automaticCandidatesOnly: boolean
  ): Promise<PublishedKnowledgeModuleSummary[]> {
    const ids = await this.listObjectIds();
    const modules: PublishedKnowledgeModuleSummary[] = [];
    for (const id of ids) {
      const manifest = await this.readManifest(id);
      if (manifestKind(manifest) !== 'knowledge' || !manifest.latestRevision) continue;
      const revision = await this.readRevision(id, manifest.latestRevision);
      const document = parseSpaceDocument(revision.source);
      if (automaticCandidatesOnly && !isAutomaticCandidate(document)) continue;
      modules.push(publishedSummaryFromDocument(document, revision));
    }
    return modules.sort((left, right) => left.name.localeCompare(right.name));
  }

  private assertManagedIdentity(manifest: StoredManifest, document: SpaceDocument): void {
    if (document.metadata.id !== manifest.id) {
      throw new Error('Stable ID is managed by SpotShell and cannot be changed');
    }
    if (document.metadata.schema_version !== SPACE_SCHEMA_VERSION) {
      throw new Error('Schema version is managed by SpotShell and cannot be changed');
    }
  }

  private async writeDraft(
    id: string,
    source: string,
    form?: KnowledgeModuleFormDraft | EnvironmentFormDraft
  ): Promise<void> {
    await this.readManifest(id);
    await this.writeJsonAtomic(this.draftPath(id), {
      source,
      savedAt: new Date().toISOString(),
      ...(form ? { form } : {}),
    });
    await this.writeWorkingSpaceFile(id, source);
    // Only mark SPACE.md as app-known; never absorb other external dirty files.
    await this.mergeExternalBaselineFiles(id, { 'SPACE.md': contentSha256(source) });
  }

  private async scanExternalChangesUnlocked(id: string): Promise<ExternalChangeStatus> {
    const manifest = await this.readManifest(id);
    const kind = manifestKind(manifest);
    const detectedAt = new Date().toISOString();

    let latestContentHash: string | undefined;
    if (manifest.latestRevision) {
      try {
        const revision = await this.readRevision(id, manifest.latestRevision);
        latestContentHash = revision.contentHash;
      } catch {
        // Missing revision metadata is handled when publishing/restoring.
      }
    }

    try {
      await fs.mkdir(this.draftFilesPath(id), { recursive: true });
      await this.assertDraftFilesRootSafe(id);
      await this.ensureWorkingSpaceFile(id);

      const working = await this.readWorkingTreeSnapshots(id);
      const baseline = await this.ensureExternalBaseline(id);
      const baselineSnapshots = snapshotsFromHashMap(baseline.files);
      const diff = detectExternalContentDiff(baselineSnapshots, working);

      const validationErrors = diff.hasChanges
        ? await this.validateWorkingTreeForAdopt(id, kind, working)
        : [];

      let status: ExternalChangeState = 'clean';
      if (diff.hasChanges) {
        status = validationErrors.length > 0 ? 'invalid' : 'pending';
      }

      return {
        id,
        kind,
        name: manifest.draftSummary.name,
        status,
        hasPendingExternalChanges: status !== 'clean',
        latestRevision: manifest.latestRevision,
        latestContentHash,
        workingContentHash: diff.workingContentHash,
        files: diff.files,
        validationErrors,
        detectedAt,
      };
    } catch (error) {
      // Quarantine unreadable trees instead of failing the whole scan pipeline.
      return {
        id,
        kind,
        name: manifest.draftSummary.name,
        status: 'invalid',
        hasPendingExternalChanges: true,
        latestRevision: manifest.latestRevision,
        latestContentHash,
        workingContentHash: '0'.repeat(64),
        files: [],
        validationErrors: [errorMessage(error)],
        detectedAt,
      };
    }
  }

  private async validateWorkingTreeForAdopt(
    id: string,
    kind: 'environment' | 'knowledge',
    working: readonly RevisionFileSnapshot[],
  ): Promise<string[]> {
    const errors: string[] = [];
    const entry = working.find((file) => file.relativePath === 'SPACE.md');
    if (!entry) {
      errors.push('SPACE.md is required');
      return errors;
    }

    let document: SpaceDocument;
    try {
      document = parseSpaceDocument(entry.content);
    } catch (error) {
      errors.push(errorMessage(error));
      return errors;
    }

    try {
      const manifest = await this.readManifest(id);
      this.assertManagedIdentity(manifest, document);
    } catch (error) {
      errors.push(errorMessage(error));
    }

    if (document.metadata.kind !== kind) {
      errors.push(`Draft must use kind: ${kind}`);
    }

    const scan = scanKnowledgeSecrets(entry.content);
    if (scan.status !== 'clean') {
      const finding = scan.findings[0];
      errors.push(
        `SPACE.md contains a possible secret (${finding?.ruleId ?? 'unknown'} at line ${finding?.line ?? 1})`,
      );
    }

    const managedPaths = working
      .map((file) => file.relativePath)
      .filter((relativePath) => relativePath !== 'SPACE.md');

    if (
      document.metadata.kind === 'knowledge'
      && (document.metadata.guidance_files?.length ?? 0) > 0
      && managedPaths.length === 0
    ) {
      errors.push('Single-file knowledge modules cannot reference guidance_files');
    }

    if (document.metadata.kind === 'knowledge') {
      for (const guidancePath of document.metadata.guidance_files ?? []) {
        try {
          const normalized = normalizeRelativePath(guidancePath);
          if (!managedPaths.includes(normalized)) {
            errors.push(`Guidance file is missing from the object: ${normalized}`);
          }
        } catch (error) {
          errors.push(errorMessage(error));
        }
      }
    }

    for (const file of working) {
      if (file.relativePath === 'SPACE.md') continue;
      try {
        assertManagedTextPath(file.relativePath);
      } catch (error) {
        errors.push(errorMessage(error));
        continue;
      }
      if (file.sizeBytes > SPACE_V1_LIMITS.maxFileBytes) {
        errors.push(`File exceeds ${SPACE_V1_LIMITS.maxFileBytes} bytes: ${file.relativePath}`);
      }
      if (file.content.includes('\0')) {
        errors.push(`Binary content is not supported: ${file.relativePath}`);
      }
      const fileScan = scanKnowledgeSecrets(file.content);
      if (fileScan.status !== 'clean') {
        const finding = fileScan.findings[0];
        errors.push(
          `Managed file contains a possible secret (${finding?.ruleId ?? 'unknown'} at ${file.relativePath}:${finding?.line ?? 1})`,
        );
      }
    }

    return errors;
  }

  private async readWorkingTreeSnapshots(id: string): Promise<RevisionFileSnapshot[]> {
    const snapshots: RevisionFileSnapshot[] = [];
    const spaceContent = await this.readWorkingSpaceContent(id);
    snapshots.push({
      relativePath: 'SPACE.md',
      content: spaceContent,
      sizeBytes: Buffer.byteLength(spaceContent, 'utf8'),
      contentHash: contentSha256(spaceContent),
    });

    const relativePaths = await this.listManagedDraftRelativePaths(id);
    for (const relativePath of relativePaths) {
      const content = await this.readManagedDraftFile(id, relativePath);
      snapshots.push({
        relativePath,
        content,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        contentHash: contentSha256(content),
      });
    }
    return snapshots;
  }

  private async readWorkingSpaceContent(id: string): Promise<string> {
    const spacePath = this.managedDraftAbsolutePath(id, 'SPACE.md');
    try {
      const bytes = await fs.readFile(spacePath);
      return decodeManagedTextBytes(bytes, 'SPACE.md');
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      const draft = await this.readDraft(id);
      return draft.source;
    }
  }

  private async ensureWorkingSpaceFile(id: string): Promise<void> {
    const spacePath = this.managedDraftAbsolutePath(id, 'SPACE.md');
    try {
      await fs.access(spacePath);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      const draft = await this.readDraft(id);
      await this.writeWorkingSpaceFile(id, draft.source);
    }
  }

  private async writeWorkingSpaceFile(id: string, source: string): Promise<void> {
    await fs.mkdir(this.draftFilesPath(id), { recursive: true });
    const absolutePath = this.managedDraftAbsolutePath(id, 'SPACE.md');
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, source, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporaryPath, absolutePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async rewriteWorkingTreeFromSnapshots(
    id: string,
    snapshots: readonly RevisionFileSnapshot[],
  ): Promise<void> {
    await fs.rm(this.draftFilesPath(id), { recursive: true, force: true });
    await fs.mkdir(this.draftFilesPath(id), { recursive: true });
    for (const file of snapshots) {
      if (file.relativePath === 'SPACE.md') {
        await this.writeWorkingSpaceFile(id, file.content);
        continue;
      }
      await this.writeManagedDraftFile(id, file.relativePath, file.content);
    }
  }

  private async ensureExternalBaseline(id: string): Promise<ExternalBaselineRecord> {
    const existing = await this.readExternalBaseline(id);
    if (existing) return existing;
    return this.captureExternalBaseline(id);
  }

  private async captureExternalBaseline(id: string): Promise<ExternalBaselineRecord> {
    const working = await this.readWorkingTreeSnapshots(id);
    const files: Record<string, string> = {};
    for (const file of working) {
      files[file.relativePath] = file.contentHash;
    }
    return this.writeExternalBaseline(id, files);
  }

  private async mergeExternalBaselineFiles(
    id: string,
    updates: Record<string, string>,
    remove: readonly string[] = [],
  ): Promise<ExternalBaselineRecord> {
    const existing = await this.readExternalBaseline(id);
    const files = { ...(existing?.files ?? {}) };
    // First app write seeds SPACE.md so later materialisation is not treated as external.
    if (!existing && !Object.prototype.hasOwnProperty.call(updates, 'SPACE.md')) {
      try {
        const space = await this.readWorkingSpaceContent(id);
        files['SPACE.md'] = contentSha256(space);
      } catch {
        // Draft may be mid-create; SPACE.md is added on the next writeDraft/publish.
      }
    }
    for (const [relativePath, contentHash] of Object.entries(updates)) {
      files[relativePath] = contentHash;
    }
    for (const relativePath of remove) {
      delete files[relativePath];
    }
    return this.writeExternalBaseline(id, files);
  }

  private async writeExternalBaseline(
    id: string,
    files: Record<string, string>,
  ): Promise<ExternalBaselineRecord> {
    const record: ExternalBaselineRecord = {
      files,
      capturedAt: new Date().toISOString(),
    };
    await this.writeJsonAtomic(this.externalBaselinePath(id), record);
    return record;
  }

  private async assertDraftFilesRootSafe(id: string): Promise<void> {
    const root = this.draftFilesPath(id);
    try {
      const stats = await fs.lstat(root);
      if (stats.isSymbolicLink()) {
        throw new ObjectRootError('Links and reparse points are not allowed: draft-files');
      }
      if (!stats.isDirectory()) {
        throw new ObjectRootError('Managed object root must be a real directory, not a link');
      }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
  }

  private async readExternalBaseline(id: string): Promise<ExternalBaselineRecord | undefined> {
    try {
      const source = await fs.readFile(this.externalBaselinePath(id), 'utf8');
      const parsed = JSON.parse(source) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      const record = parsed as Partial<ExternalBaselineRecord>;
      if (!record.files || typeof record.files !== 'object' || Array.isArray(record.files)) {
        return undefined;
      }
      if (typeof record.capturedAt !== 'string') return undefined;
      const files: Record<string, string> = {};
      for (const [key, value] of Object.entries(record.files)) {
        if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) {
          files[key] = value;
        }
      }
      return { files, capturedAt: record.capturedAt };
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async readManifest(id: string): Promise<StoredManifest> {
    assertSafeId(id);
    const source = await fs.readFile(this.manifestPath(id), 'utf8');
    return manifestSchema.parse(JSON.parse(source));
  }

  private async readDraft(id: string): Promise<DraftRecord> {
    const source = await fs.readFile(this.draftPath(id), 'utf8');
    return draftRecordSchema.parse(JSON.parse(source));
  }

  private async readRevision(id: string, revision: number): Promise<SpaceRevision> {
    const source = await fs.readFile(
      path.join(this.revisionPath(id, revision), 'revision.json'),
      'utf8'
    );
    const parsed = storedRevisionSchema.parse(JSON.parse(source));
    if (parsed.id !== id || parsed.revision !== revision) {
      throw new Error(`Revision metadata mismatch for ${id}@${revision}`);
    }
    return {
      id: parsed.id,
      revision: parsed.revision,
      contentHash: parsed.contentHash,
      createdAt: parsed.createdAt,
      source: parsed.source,
      ...(parsed.origin ? { origin: parsed.origin } : {}),
      ...(parsed.files ? { files: parsed.files } : {}),
    };
  }

  private async listRevisionHistoryUnlocked(
    id: string,
    protection: Omit<RevisionProtectionInput, 'latestRevision'> = {},
  ): Promise<RevisionHistoryEntry[]> {
    const manifest = await this.readManifest(id);
    const numbers = await this.listStoredRevisionNumbers(id);
    const blobReferences = await this.collectBlobReferences(id, numbers);
    const fullProtection: RevisionProtectionInput = {
      ...protection,
      latestRevision: manifest.latestRevision,
    };
    const entries: RevisionHistoryEntry[] = [];
    for (const revision of numbers) {
      const loaded = await this.readRevision(id, revision);
      const sizeBytes = await this.revisionMaterializedBytes(id, revision);
      entries.push(annotateRevisionHistoryEntry({
        id,
        revision,
        contentHash: loaded.contentHash,
        createdAt: loaded.createdAt,
        origin: normalizeRevisionOrigin(loaded.origin),
        sizeBytes,
        exclusiveBytes: exclusiveBytesForRevision(revision, blobReferences),
        protection: fullProtection,
      }));
    }
    return entries;
  }

  private async previewRevisionCleanupUnlocked(
    id: string,
    revisions: readonly number[],
    protection: Omit<RevisionProtectionInput, 'latestRevision'> = {},
  ): Promise<RevisionCleanupPreview> {
    const manifest = await this.readManifest(id);
    const availableRevisions = await this.listStoredRevisionNumbers(id);
    const blobReferences = await this.collectBlobReferences(id, availableRevisions);
    return planRevisionCleanup({
      objectId: id,
      requestedRevisions: revisions,
      availableRevisions,
      protection: {
        ...protection,
        latestRevision: manifest.latestRevision,
      },
      blobReferences,
    });
  }

  private async listStoredRevisionNumbers(id: string): Promise<number[]> {
    const revisionsDir = path.join(this.objectPath(id), 'revisions');
    try {
      const entries = await fs.readdir(revisionsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && /^\d{8}$/.test(entry.name))
        .map((entry) => Number(entry.name))
        .filter((revision) => Number.isInteger(revision) && revision >= 1)
        .sort((left, right) => right - left);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
  }

  private async readRevisionFileSnapshots(
    id: string,
    revision: number,
  ): Promise<RevisionFileSnapshot[]> {
    const root = await SafeObjectRoot.open(this.revisionPath(id, revision));
    const files = await root.listTextFiles();
    return files
      .filter((file) => file.relativePath !== 'revision.json')
      .map((file) => ({
        relativePath: file.relativePath,
        content: file.content,
        sizeBytes: file.sizeBytes,
        contentHash: contentSha256(file.content),
      }));
  }

  private async revisionFileHashMap(
    id: string,
    revision: number,
  ): Promise<Record<string, string>> {
    const loaded = await this.readRevision(id, revision);
    if (loaded.files && Object.keys(loaded.files).length > 0) {
      return { ...loaded.files };
    }
    const snapshots = await this.readRevisionFileSnapshots(id, revision);
    const map: Record<string, string> = {};
    for (const file of snapshots) {
      map[file.relativePath] = file.contentHash;
    }
    return map;
  }

  private async revisionMaterializedBytes(id: string, revision: number): Promise<number> {
    const snapshots = await this.readRevisionFileSnapshots(id, revision);
    return snapshots.reduce((sum, file) => sum + file.sizeBytes, 0);
  }

  private async collectBlobReferences(
    id: string,
    revisions: readonly number[],
  ): Promise<BlobReference[]> {
    const byHash = new Map<string, { sizeBytes: number; revisions: number[] }>();
    for (const revision of revisions) {
      const fileMap = await this.revisionFileHashMap(id, revision);
      for (const [relativePath, contentHash] of Object.entries(fileMap)) {
        let sizeBytes = await this.blobSizeBytes(id, contentHash);
        if (sizeBytes === undefined) {
          try {
            const absolute = path.join(
              this.revisionPath(id, revision),
              ...relativePath.split('/'),
            );
            const stats = await fs.stat(absolute);
            sizeBytes = stats.size;
          } catch {
            sizeBytes = 0;
          }
        }
        const existing = byHash.get(contentHash);
        if (existing) {
          if (!existing.revisions.includes(revision)) {
            existing.revisions.push(revision);
          }
          existing.sizeBytes = Math.max(existing.sizeBytes, sizeBytes);
        } else {
          byHash.set(contentHash, { sizeBytes, revisions: [revision] });
        }
      }
    }
    return [...byHash.entries()].map(([contentHash, value]) => ({
      contentHash,
      sizeBytes: value.sizeBytes,
      revisions: value.revisions,
    }));
  }

  private async blobSizeBytes(id: string, contentHash: string): Promise<number | undefined> {
    try {
      const stats = await fs.stat(this.blobPath(id, contentHash));
      return stats.size;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  /**
   * Write object files through the content-addressed blob store and link them
   * into the revision directory so harness reads keep working unchanged.
   */
  private async materializeRevisionFiles(
    id: string,
    temporaryRevisionPath: string,
    files: readonly { relativePath: string; content: string }[],
  ): Promise<Record<string, string>> {
    const fileMap: Record<string, string> = {};
    await fs.mkdir(this.blobsPath(id), { recursive: true });
    for (const file of files) {
      const hash = contentSha256(file.content);
      fileMap[file.relativePath] = hash;
      const blobPath = this.blobPath(id, hash);
      try {
        await fs.access(blobPath);
      } catch {
        const temporaryBlob = `${blobPath}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporaryBlob, file.content, { encoding: 'utf8', flag: 'wx' });
          try {
            await fs.rename(temporaryBlob, blobPath);
          } catch (error) {
            await fs.rm(temporaryBlob, { force: true });
            // Concurrent writer may have created the blob first.
            try {
              await fs.access(blobPath);
            } catch {
              throw error;
            }
          }
        } catch (error) {
          await fs.rm(temporaryBlob, { force: true });
          try {
            await fs.access(blobPath);
          } catch {
            throw error;
          }
        }
      }

      const targetPath = path.join(temporaryRevisionPath, ...file.relativePath.split('/'));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        await fs.link(blobPath, targetPath);
      } catch {
        await fs.copyFile(blobPath, targetPath);
      }
    }
    return fileMap;
  }

  /** Remove blobs no longer referenced by any remaining revision. Returns freed bytes. */
  private async garbageCollectBlobs(id: string): Promise<number> {
    const blobsDir = this.blobsPath(id);
    let entries: string[];
    try {
      entries = await fs.readdir(blobsDir);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return 0;
      throw error;
    }

    const revisions = await this.listStoredRevisionNumbers(id);
    const referenced = new Set<string>();
    for (const revision of revisions) {
      const fileMap = await this.revisionFileHashMap(id, revision);
      for (const hash of Object.values(fileMap)) {
        referenced.add(hash);
      }
    }

    let freed = 0;
    for (const name of entries) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      if (referenced.has(name)) continue;
      const absolute = path.join(blobsDir, name);
      try {
        const stats = await fs.stat(absolute);
        await fs.rm(absolute, { force: true });
        freed += stats.size;
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    }
    return freed;
  }

  private async assertDiskSpaceForRevision(estimatedWriteBytes: number): Promise<void> {
    const freeBytes = await this.resolveFreeDiskBytes();
    if (freeBytes === undefined) return;
    assertEnoughDiskSpace({
      freeBytes,
      minFreeBytes: this.minFreeBytes,
      estimatedWriteBytes,
    });
  }

  private async resolveFreeDiskBytes(): Promise<number | undefined> {
    if (this.getFreeDiskBytes) {
      return this.getFreeDiskBytes(this.rootPath);
    }
    try {
      const stats = await fs.statfs(this.rootPath);
      return Number(stats.bfree) * Number(stats.bsize);
    } catch {
      return undefined;
    }
  }

  private blobsPath(id: string): string {
    return path.join(this.objectPath(id), 'blobs');
  }

  private blobPath(id: string, contentHash: string): string {
    return path.join(this.blobsPath(id), contentHash);
  }

  private async readRevisionIfExists(
    id: string,
    revision: number
  ): Promise<SpaceRevision | undefined> {
    try {
      return await this.readRevision(id, revision);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async listObjectIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && isSafeId(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
  }

  private objectPath(id: string): string {
    assertSafeId(id);
    return path.join(this.rootPath, id);
  }

  private manifestPath(id: string): string {
    return path.join(this.objectPath(id), 'manifest.json');
  }

  private draftPath(id: string): string {
    return path.join(this.objectPath(id), 'draft.json');
  }

  private draftFilesPath(id: string): string {
    return path.join(this.objectPath(id), 'draft-files');
  }

  private externalBaselinePath(id: string): string {
    return path.join(this.objectPath(id), 'external-baseline.json');
  }

  private fileOriginsPath(id: string): string {
    return path.join(this.objectPath(id), 'file-origins.json');
  }

  private revisionPath(id: string, revision: number): string {
    return path.join(this.objectPath(id), 'revisions', String(revision).padStart(8, '0'));
  }

  private assertWritableManagedPath(relativePath: string): string {
    const normalized = assertManagedTextPath(relativePath);
    if (normalized === 'SPACE.md') {
      throw new Error('SPACE.md is managed through the object editor, not as a managed file');
    }
    return normalized;
  }

  private assertManagedContentWritable(relativePath: string, content: string): void {
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > SPACE_V1_LIMITS.maxFileBytes) {
      throw new Error(`File exceeds ${SPACE_V1_LIMITS.maxFileBytes} bytes: ${relativePath}`);
    }
    if (content.includes('\0')) {
      throw new ObjectRootError(`Binary content is not supported: ${relativePath}`);
    }
    const scan = scanKnowledgeSecrets(content);
    if (scan.status === 'blocked') {
      const finding = scan.findings[0];
      throw new Error(
        `Draft contains a possible secret (${finding?.ruleId ?? 'unknown'} at line ${finding?.line ?? 1})`
      );
    }
  }

  private async loadManagedFiles(id: string): Promise<ManagedObjectFilesDetail> {
    const manifest = await this.readManifest(id);
    const kind = manifestKind(manifest);
    const guidanceFiles = await this.readDraftGuidanceFiles(id, kind);
    const guidanceSet = new Set(guidanceFiles);
    const relativePaths = await this.listManagedDraftRelativePaths(id);
    const origins = await this.readFileOrigins(id);
    const files: ManagedObjectFileSummary[] = [];
    for (const relativePath of relativePaths) {
      const content = await this.readManagedDraftFile(id, relativePath);
      const sizeBytes = Buffer.byteLength(content, 'utf8');
      const scan = scanKnowledgeSecrets(content);
      const origin = origins[relativePath];
      files.push({
        relativePath,
        sizeBytes,
        role: guidanceSet.has(relativePath) ? 'guidance' : 'reference',
        guidanceEligible: isGuidanceEligiblePath(relativePath),
        ...(origin ? { origin } : {}),
        secretStatus: scan.status,
      });
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    return {
      id,
      kind,
      files,
      guidanceFiles,
    };
  }

  private async readDraftGuidanceFiles(
    id: string,
    kind: 'environment' | 'knowledge',
  ): Promise<string[]> {
    if (kind !== 'knowledge') return [];
    try {
      const draft = await this.readDraft(id);
      const document = parseSpaceDocument(draft.source);
      if (document.metadata.kind !== 'knowledge') return [];
      return [...(document.metadata.guidance_files ?? [])].map((value) => normalizeRelativePath(value));
    } catch {
      return [];
    }
  }

  private async listManagedDraftRelativePaths(id: string): Promise<string[]> {
    const root = this.draftFilesPath(id);
    try {
      const stats = await fs.lstat(root);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
    const files: string[] = [];
    await walkDraftFiles(root, '', files);
    return filterWorkingContentPaths(files)
      .filter((relativePath) => relativePath !== 'SPACE.md')
      .sort((left, right) => left.localeCompare(right, 'en-US'));
  }

  private async managedFileExists(id: string, relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.managedDraftAbsolutePath(id, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  private managedDraftAbsolutePath(id: string, relativePath: string): string {
    return path.join(this.draftFilesPath(id), ...relativePath.split('/'));
  }

  private async readManagedDraftFile(id: string, relativePath: string): Promise<string> {
    const absolutePath = this.managedDraftAbsolutePath(id, relativePath);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absolutePath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new Error(`Managed file does not exist: ${relativePath}`);
      }
      throw error;
    }
    return decodeManagedTextBytes(bytes, relativePath);
  }

  private async writeManagedDraftFile(
    id: string,
    relativePath: string,
    content: string,
  ): Promise<void> {
    const absolutePath = this.managedDraftAbsolutePath(id, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporaryPath, absolutePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
    if (relativePath !== 'SPACE.md') {
      await this.mergeExternalBaselineFiles(id, {
        [relativePath]: contentSha256(content),
      });
    }
  }

  private async readFileOrigins(id: string): Promise<FileOriginsRecord> {
    try {
      const source = await fs.readFile(this.fileOriginsPath(id), 'utf8');
      const parsed = JSON.parse(source) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const result: FileOriginsRecord = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const origin = value as Partial<ManagedObjectFileOrigin>;
        if (
          typeof origin.sourcePath === 'string'
          && typeof origin.originalName === 'string'
          && typeof origin.importedAt === 'string'
          && typeof origin.contentHash === 'string'
        ) {
          result[key] = {
            sourcePath: origin.sourcePath,
            originalName: origin.originalName,
            importedAt: origin.importedAt,
            contentHash: origin.contentHash,
          };
        }
      }
      return result;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return {};
      throw error;
    }
  }

  private async writeFileOrigins(id: string, origins: FileOriginsRecord): Promise<void> {
    if (Object.keys(origins).length === 0) {
      await fs.rm(this.fileOriginsPath(id), { force: true });
      return;
    }
    await this.writeJsonAtomic(this.fileOriginsPath(id), origins);
  }

  private async readExternalTextFile(
    absoluteSourcePath: string,
    relativePath: string,
  ): Promise<string> {
    let stats;
    try {
      stats = await fs.lstat(absoluteSourcePath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new Error(`Source file is not accessible: ${absoluteSourcePath}`);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new ObjectRootError(`Links and reparse points are not allowed: ${relativePath}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Source path is not a regular file: ${absoluteSourcePath}`);
    }
    if (stats.size > SPACE_V1_LIMITS.maxFileBytes) {
      throw new Error(`File exceeds ${SPACE_V1_LIMITS.maxFileBytes} bytes: ${relativePath}`);
    }
    // Reject by intended managed path first so PDF imports fail clearly.
    assertManagedTextPath(relativePath);
    const sourceName = path.basename(absoluteSourcePath);
    if (sourceName.toLocaleLowerCase('en-US').endsWith('.pdf')) {
      throw new ObjectRootError(`PDF files are not supported in schema v1: ${relativePath}`);
    }
    const bytes = await fs.readFile(absoluteSourcePath);
    if (bytes.byteLength > SPACE_V1_LIMITS.maxFileBytes) {
      throw new Error(`File exceeds ${SPACE_V1_LIMITS.maxFileBytes} bytes: ${relativePath}`);
    }
    return decodeManagedTextBytes(bytes, relativePath);
  }

  private async rewriteGuidanceFiles(
    id: string,
    rewrite: (files: string[]) => string[],
  ): Promise<void> {
    const draft = await this.readDraft(id);
    const document = parseSpaceDocument(draft.source);
    if (document.metadata.kind !== 'knowledge') {
      throw new Error('Only knowledge modules support guidance_files');
    }
    this.assertManagedIdentity(await this.readManifest(id), document);
    const nextFiles = rewrite([...(document.metadata.guidance_files ?? [])]
      .map((value) => normalizeRelativePath(value)));
    const metadata: KnowledgeSpaceMetadata = {
      ...document.metadata,
      ...(nextFiles.length > 0
        ? { guidance_files: nextFiles }
        : { guidance_files: undefined }),
    };
    // Drop empty guidance_files key for a clean YAML dump.
    if (!metadata.guidance_files || metadata.guidance_files.length === 0) {
      delete metadata.guidance_files;
    }
    const nextDocument: SpaceDocument = { metadata, body: document.body };
    const source = serializeSpaceDocument(nextDocument);
    assertSpaceSourceSize(source);
    const form = toKnowledgeForm(nextDocument);
    await this.writeDraft(id, source, form);
    await this.writeJsonAtomic(this.manifestPath(id), {
      ...(await this.readManifest(id)),
      draftSummary: summaryFromDocument(nextDocument),
    });
  }

  private async pruneEmptyDraftDirectories(id: string, relativeDirectory: string): Promise<void> {
    if (!relativeDirectory || relativeDirectory === '.') return;
    const absoluteDirectory = path.join(this.draftFilesPath(id), ...relativeDirectory.split('/'));
    try {
      const entries = await fs.readdir(absoluteDirectory);
      if (entries.length === 0) {
        await fs.rmdir(absoluteDirectory);
        await this.pruneEmptyDraftDirectories(id, path.posix.dirname(relativeDirectory));
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }

  private async writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private trashRootPath(): string {
    return path.join(this.rootPath, 'trash');
  }

  private trashObjectPath(id: string): string {
    assertSafeId(id);
    return path.join(this.trashRootPath(), id);
  }

  private toTrashSummary(record: TrashRecord, now: Date): TrashEntrySummary {
    return {
      id: record.id,
      kind: record.kind,
      name: record.name,
      deletedAt: record.deletedAt,
      expiresAt: record.expiresAt,
      ...(record.latestRevision !== undefined ? { latestRevision: record.latestRevision } : {}),
      ...(record.contentHash !== undefined ? { contentHash: record.contentHash } : {}),
      daysRemaining: daysRemaining(record.expiresAt, now),
    };
  }

  private async collectModuleReferences(
    moduleId: string,
  ): Promise<ModuleReferenceByEnvironment[]> {
    const ids = await this.listObjectIds();
    const refs: ModuleReferenceByEnvironment[] = [];
    for (const environmentId of ids) {
      const manifest = await this.readManifest(environmentId);
      if (manifestKind(manifest) !== 'environment') continue;
      const modes = new Set<'always' | 'on_demand'>();

      try {
        const draft = await this.readDraft(environmentId);
        if (isEnvironmentForm(draft.form)) {
          if (draft.form.always.includes(moduleId)) modes.add('always');
          if (draft.form.onDemand.includes(moduleId)) modes.add('on_demand');
        }
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }

      if (manifest.latestRevision) {
        try {
          const revision = await this.readRevision(environmentId, manifest.latestRevision);
          const document = parseSpaceDocument(revision.source);
          if (document.metadata.kind === 'environment') {
            if (document.metadata.modules.always.includes(moduleId)) modes.add('always');
            if (document.metadata.modules.on_demand.includes(moduleId)) modes.add('on_demand');
          }
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error;
        }
      }

      if (modes.size === 0) continue;
      for (const mode of modes) {
        refs.push({
          environmentId,
          environmentName: manifest.draftSummary.name,
          mode,
        });
      }
    }
    return refs;
  }

  private async readEnvironmentAssociationIds(id: string): Promise<{
    always: string[];
    onDemand: string[];
  }> {
    const manifest = await this.readManifest(id);
    if (manifest.latestRevision) {
      try {
        const revision = await this.readRevision(id, manifest.latestRevision);
        const document = parseSpaceDocument(revision.source);
        if (document.metadata.kind === 'environment') {
          return {
            always: [...document.metadata.modules.always],
            onDemand: [...document.metadata.modules.on_demand],
          };
        }
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    }
    try {
      const draft = await this.readDraft(id);
      if (isEnvironmentForm(draft.form)) {
        return {
          always: [...draft.form.always],
          onDemand: [...draft.form.onDemand],
        };
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    return { always: [], onDemand: [] };
  }

  private async moveObjectToTrashUnlocked(
    id: string,
    kind: TrashObjectKind,
    referenceSnapshot: TrashReferenceSnapshot,
  ): Promise<TrashMoveResult> {
    assertSafeId(id);
    const manifest = await this.readManifest(id);
    let contentHash: string | undefined;
    if (manifest.latestRevision) {
      try {
        const revision = await this.readRevision(id, manifest.latestRevision);
        contentHash = revision.contentHash;
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    }

    const deletedAt = new Date().toISOString();
    const record = buildTrashRecord({
      id,
      kind,
      name: manifest.draftSummary.name,
      deletedAt,
      latestRevision: manifest.latestRevision,
      contentHash,
      referenceSnapshot,
    });

    // Write marker into the live object first so a crash mid-rename is recoverable.
    await this.writeJsonAtomic(path.join(this.objectPath(id), 'trash.json'), record);
    await fs.mkdir(this.trashRootPath(), { recursive: true });
    const destination = this.trashObjectPath(id);
    if (await pathExists(destination)) {
      throw new Error(`Trash already contains object ${id}`);
    }
    try {
      await fs.rename(this.objectPath(id), destination);
    } catch (error) {
      // Leave trash.json in place for repairTrashState; do not delete the live object.
      throw error;
    }

    return {
      ...this.toTrashSummary(record, new Date(deletedAt)),
      referenceSnapshot: record.referenceSnapshot,
    };
  }

  private async listTrashRecords(): Promise<TrashRecord[]> {
    const root = this.trashRootPath();
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
    const records: TrashRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      try {
        records.push(await this.readTrashRecord(entry.name));
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) continue;
        throw error;
      }
    }
    return records;
  }

  private async readTrashRecord(id: string): Promise<TrashRecord> {
    assertSafeId(id);
    const source = await fs.readFile(path.join(this.trashObjectPath(id), 'trash.json'), 'utf8');
    return trashRecordSchema.parse(JSON.parse(source));
  }

  private async reportRestoredAssociations(
    record: TrashRecord,
  ): Promise<RestoreAssociationResult[]> {
    if (record.kind !== 'environment') return [];
    const available = new Set<string>();
    for (const objectId of await this.listObjectIds()) {
      try {
        const manifest = await this.readManifest(objectId);
        if (manifestKind(manifest) === 'knowledge') available.add(objectId);
      } catch {
        // Skip unreadable ids.
      }
    }
    let currentAssociations = { always: [] as string[], onDemand: [] as string[] };
    try {
      currentAssociations = await this.readEnvironmentAssociationIds(record.id);
    } catch {
      currentAssociations = {
        always: [...record.referenceSnapshot.associations.always],
        onDemand: [...record.referenceSnapshot.associations.onDemand],
      };
    }
    return planRestoreAssociations({
      kind: 'environment',
      snapshot: record.referenceSnapshot,
      availableModuleIds: available,
      currentAssociations,
    });
  }

  private async repairTrashStateUnlocked(): Promise<TrashRepairResult> {
    const completedMoves: string[] = [];
    const ids = await this.listObjectIds();
    for (const id of ids) {
      const markerPath = path.join(this.objectPath(id), 'trash.json');
      if (!(await pathExists(markerPath))) continue;
      await fs.mkdir(this.trashRootPath(), { recursive: true });
      const destination = this.trashObjectPath(id);
      if (await pathExists(destination)) {
        // Destination already exists — remove the incomplete active copy after verifying marker.
        await fs.rm(this.objectPath(id), { recursive: true, force: true });
        completedMoves.push(id);
        continue;
      }
      await fs.rename(this.objectPath(id), destination);
      completedMoves.push(id);
    }
    return { completedMoves };
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function walkDraftFiles(
  absoluteRoot: string,
  relativeDirectory: string,
  files: string[],
): Promise<void> {
  const absoluteDirectory = relativeDirectory
    ? path.join(absoluteRoot, ...relativeDirectory.split('/'))
    : absoluteRoot;
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const stats = await fs.lstat(absolutePath);
    if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
      throw new ObjectRootError(`Links and reparse points are not allowed: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      if (isEditorTemporaryPath(relativePath)) continue;
      await walkDraftFiles(absoluteRoot, relativePath, files);
      continue;
    }
    if (!stats.isFile()) {
      throw new ObjectRootError(`Unsupported filesystem entry: ${relativePath}`);
    }
    // Editor swap/backup files must not break listing or become managed content.
    if (isEditorTemporaryPath(relativePath)) continue;
    if (relativePath === 'SPACE.md') {
      files.push('SPACE.md');
      continue;
    }
    assertManagedTextPath(relativePath);
    files.push(normalizeRelativePath(relativePath));
  }
}

function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function snapshotsFromHashMap(files: Record<string, string>): RevisionFileSnapshot[] {
  return Object.entries(files)
    .map(([relativePath, contentHash]) => ({
      relativePath,
      content: '',
      sizeBytes: 0,
      contentHash,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
}

function toKnowledgeForm(document: SpaceDocument): KnowledgeModuleFormDraft {
  if (document.metadata.kind !== 'knowledge') {
    throw new Error('Knowledge repository cannot load an environment profile');
  }
  const form = toSpaceForm(document);
  return {
    name: document.metadata.name,
    description: document.metadata.description,
    whenToUse: document.metadata.when_to_use,
    whenNotToUse: document.metadata.when_not_to_use,
    tags: document.metadata.tags ?? [],
    beforeGuidance: form.beforeGuidance,
    inlineGuidance: form.inlineGuidance,
    afterGuidance: form.afterGuidance,
  };
}

function toEnvironmentForm(document: SpaceDocument): EnvironmentFormDraft {
  if (document.metadata.kind !== 'environment') {
    throw new Error('Knowledge repository cannot load a knowledge module as an environment');
  }
  return {
    name: document.metadata.name,
    description: document.metadata.description,
    tags: document.metadata.tags ?? [],
    always: document.metadata.modules.always,
    onDemand: document.metadata.modules.on_demand,
    body: document.body,
  };
}

function environmentSummaryFromDocument(document: SpaceDocument): DraftSummary {
  if (document.metadata.kind !== 'environment') {
    throw new Error('Knowledge repository cannot summarize a knowledge module as an environment');
  }
  return {
    name: document.metadata.name,
    description: document.metadata.description,
    tags: document.metadata.tags ?? [],
  };
}

function summaryFromDocument(
  document: SpaceDocument
): DraftSummary & { whenToUse: string } {
  if (document.metadata.kind !== 'knowledge') {
    throw new Error('Knowledge repository cannot summarize an environment profile');
  }
  return {
    name: document.metadata.name,
    description: document.metadata.description,
    whenToUse: document.metadata.when_to_use,
    tags: document.metadata.tags ?? [],
  };
}

function toSpaceFormDraft(id: string, form: KnowledgeModuleFormDraft) {
  return {
    metadata: {
      schema_version: SPACE_SCHEMA_VERSION,
      id,
      kind: 'knowledge' as const,
      name: form.name,
      description: form.description,
      when_to_use: form.whenToUse,
      ...(form.whenNotToUse ? { when_not_to_use: form.whenNotToUse } : {}),
      ...(form.tags.length > 0 ? { tags: form.tags } : {}),
    },
    beforeGuidance: form.beforeGuidance,
    inlineGuidance: form.inlineGuidance,
    afterGuidance: form.afterGuidance,
  };
}

function toEnvironmentSpaceFormDraft(id: string, form: EnvironmentFormDraft) {
  return {
    metadata: {
      schema_version: SPACE_SCHEMA_VERSION,
      id,
      kind: 'environment' as const,
      name: form.name,
      description: form.description,
      ...(form.tags.length > 0 ? { tags: form.tags } : {}),
      modules: {
        always: form.always,
        on_demand: form.onDemand,
      },
    },
    beforeGuidance: form.body,
    afterGuidance: '',
  };
}

function serializeUnvalidatedForm(id: string, form: KnowledgeModuleFormDraft): string {
  const metadata = toSpaceFormDraft(id, form).metadata;
  const yaml = stringify(metadata, { lineWidth: 0 }).trimEnd();
  const bodyParts = [normalizeDraftBody(form.beforeGuidance).trimEnd()];
  if (form.inlineGuidance !== undefined) {
    bodyParts.push('## Guidance');
    const guidance = normalizeDraftBody(form.inlineGuidance).trimEnd();
    if (guidance) bodyParts.push(guidance);
  }
  const afterGuidance = normalizeDraftBody(form.afterGuidance).trimEnd();
  if (afterGuidance) bodyParts.push(afterGuidance);
  const body = bodyParts.filter(Boolean).join('\n\n');
  return `---\n${yaml}\n---\n\n${body}${body ? '\n' : ''}`;
}

function serializeUnvalidatedEnvironmentForm(id: string, form: EnvironmentFormDraft): string {
  const metadata = toEnvironmentSpaceFormDraft(id, form).metadata;
  const yaml = stringify(metadata, { lineWidth: 0 }).trimEnd();
  const body = normalizeDraftBody(form.body).trimEnd();
  return `---\n${yaml}\n---\n\n${body}${body ? '\n' : ''}`;
}

function normalizeDraftBody(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/^\n+/, '');
}

function manifestKind(manifest: StoredManifest): 'environment' | 'knowledge' {
  return manifest.kind ?? 'knowledge';
}

function publishedSummaryFromDocument(
  document: SpaceDocument,
  revision: SpaceRevision
): PublishedKnowledgeModuleSummary {
  const metadata = document.metadata;
  if (metadata.kind !== 'knowledge') throw new Error('Published object is not a knowledge module');
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    whenToUse: metadata.when_to_use,
    tags: metadata.tags ?? [],
    revision: revision.revision,
    contentHash: revision.contentHash,
  };
}

function isAutomaticCandidate(document: SpaceDocument): boolean {
  const metadata = document.metadata;
  if (metadata.kind !== 'knowledge') return false;
  return metadata.name.trim().length > 0
    && metadata.description.trim().length > 0
    && metadata.description !== 'Describe what this knowledge module contains.'
    && metadata.when_to_use.trim().length > 0
    && metadata.when_to_use !== 'Describe when this knowledge module should be used.'
    && hasSubstantiveSpaceContent(document);
}

function isKnowledgeForm(
  form: DraftRecord['form']
): form is KnowledgeModuleFormDraft {
  return form !== undefined && 'whenToUse' in form;
}

function isEnvironmentForm(
  form: DraftRecord['form']
): form is EnvironmentFormDraft {
  return form !== undefined && 'always' in form;
}

function assertSafeId(id: string): void {
  if (!isSafeId(id)) {
    throw new Error('Invalid knowledge module ID');
  }
}

function isSafeId(id: string): boolean {
  return z.string().uuid().safeParse(id).success && id === id.toLocaleLowerCase('en-US');
}

function assertSpaceSourceSize(source: string): void {
  const sizeBytes = Buffer.byteLength(source, 'utf8');
  if (sizeBytes > SPACE_V1_LIMITS.maxFileBytes) {
    throw new Error(
      `SPACE source exceeds the ${SPACE_V1_LIMITS.maxFileBytes} byte limit`
    );
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
