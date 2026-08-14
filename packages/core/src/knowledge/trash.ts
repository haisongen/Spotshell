/**
 * Pure helpers for reference-aware deletion and 30-day trash (ADR-023).
 * Storage I/O stays in KnowledgeRepository.
 */

export const DEFAULT_TRASH_RETENTION_DAYS = 30;

export type TrashObjectKind = 'environment' | 'knowledge';
export type ModuleAssociationMode = 'always' | 'on_demand';

export interface ModuleReferenceByEnvironment {
  environmentId: string;
  environmentName: string;
  mode: ModuleAssociationMode;
}

export interface EnvironmentHostBinding {
  hostId: string;
  hostName: string;
}

export interface TrashReferenceSnapshot {
  /** Reverse references to a knowledge module at delete time (empty when allowed). */
  referencedBy: ModuleReferenceByEnvironment[];
  /** Environment → module associations captured at delete time. */
  associations: {
    always: string[];
    onDemand: string[];
  };
  /** Host bindings that blocked environment delete (empty when allowed). */
  boundHosts: EnvironmentHostBinding[];
}

export interface TrashRecord {
  id: string;
  kind: TrashObjectKind;
  name: string;
  deletedAt: string;
  expiresAt: string;
  latestRevision?: number;
  contentHash?: string;
  referenceSnapshot: TrashReferenceSnapshot;
}

export type DeleteBlockerCode =
  | 'module-referenced'
  | 'environment-bound'
  | 'object-missing'
  | 'already-trashed'
  | 'agent-active'
  | 'id-conflict';

export interface DeleteBlocker {
  code: DeleteBlockerCode;
  message: string;
}

export interface ModuleDeletePreview {
  id: string;
  kind: 'knowledge';
  name: string;
  canDelete: boolean;
  blockers: DeleteBlocker[];
  referencedBy: ModuleReferenceByEnvironment[];
  retentionDays: number;
  estimatedExpiresAt: string;
}

export interface EnvironmentDeletePreview {
  id: string;
  kind: 'environment';
  name: string;
  canDelete: boolean;
  blockers: DeleteBlocker[];
  boundHosts: EnvironmentHostBinding[];
  associations: {
    always: string[];
    onDemand: string[];
  };
  retentionDays: number;
  estimatedExpiresAt: string;
}

export type DeletePreview = ModuleDeletePreview | EnvironmentDeletePreview;

export type RestoreAssociationStatus =
  | 'restored'
  | 'skipped-missing'
  | 'skipped-conflict'
  | 'already-present';

export interface RestoreAssociationResult {
  moduleId: string;
  mode: ModuleAssociationMode;
  status: RestoreAssociationStatus;
}

export interface PermanentDeletePreview {
  id: string;
  kind: TrashObjectKind;
  name: string;
  canPermanentlyDelete: boolean;
  blockers: DeleteBlocker[];
  irreversible: true;
  expiresAt: string;
  daysRemaining: number;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Compute ISO expiry timestamp from deletion time and retention days. */
export function computeExpiresAt(
  deletedAt: Date | string,
  retentionDays: number = DEFAULT_TRASH_RETENTION_DAYS,
): string {
  const base = asDate(deletedAt);
  const expires = new Date(base.getTime());
  expires.setUTCDate(expires.getUTCDate() + retentionDays);
  return expires.toISOString();
}

export function isExpired(expiresAt: string, now: Date = new Date()): boolean {
  return asDate(now).getTime() >= asDate(expiresAt).getTime();
}

/** Whole days remaining until expiry (0 when expired or same calendar day past). */
export function daysRemaining(expiresAt: string, now: Date = new Date()): number {
  const ms = asDate(expiresAt).getTime() - asDate(now).getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

export function planModuleDelete(input: {
  id: string;
  name: string;
  referencedBy: readonly ModuleReferenceByEnvironment[];
  now?: Date;
  retentionDays?: number;
}): ModuleDeletePreview {
  const retentionDays = input.retentionDays ?? DEFAULT_TRASH_RETENTION_DAYS;
  const now = input.now ?? new Date();
  const referencedBy = [...input.referencedBy];
  const blockers: DeleteBlocker[] = [];
  if (referencedBy.length > 0) {
    blockers.push({
      code: 'module-referenced',
      message:
        `Knowledge module is still referenced by ${referencedBy.length} environment(s); `
        + 'unlink or replace every association before deleting.',
    });
  }
  return {
    id: input.id,
    kind: 'knowledge',
    name: input.name,
    canDelete: blockers.length === 0,
    blockers,
    referencedBy,
    retentionDays,
    estimatedExpiresAt: computeExpiresAt(now, retentionDays),
  };
}

export function planEnvironmentDelete(input: {
  id: string;
  name: string;
  boundHosts: readonly EnvironmentHostBinding[];
  associations: {
    always: readonly string[];
    onDemand: readonly string[];
  };
  now?: Date;
  retentionDays?: number;
}): EnvironmentDeletePreview {
  const retentionDays = input.retentionDays ?? DEFAULT_TRASH_RETENTION_DAYS;
  const now = input.now ?? new Date();
  const boundHosts = [...input.boundHosts];
  const blockers: DeleteBlocker[] = [];
  if (boundHosts.length > 0) {
    blockers.push({
      code: 'environment-bound',
      message:
        `Environment is still bound to ${boundHosts.length} local host(s); `
        + 'clear every host binding before deleting.',
    });
  }
  return {
    id: input.id,
    kind: 'environment',
    name: input.name,
    canDelete: blockers.length === 0,
    blockers,
    boundHosts,
    associations: {
      always: [...input.associations.always],
      onDemand: [...input.associations.onDemand],
    },
    retentionDays,
    estimatedExpiresAt: computeExpiresAt(now, retentionDays),
  };
}

/** Throw when a delete preview is blocked. */
export function assertCanMoveToTrash(preview: DeletePreview): void {
  if (preview.canDelete) return;
  const first = preview.blockers[0];
  if (first?.code === 'module-referenced') {
    throw new Error(
      first.message || 'Knowledge module is still referenced and cannot be deleted',
    );
  }
  if (first?.code === 'environment-bound') {
    throw new Error(
      first.message || 'Environment is still bound to a host and cannot be deleted',
    );
  }
  throw new Error(first?.message ?? 'Object cannot be moved to trash');
}

export function buildTrashRecord(input: {
  id: string;
  kind: TrashObjectKind;
  name: string;
  deletedAt: string;
  latestRevision?: number;
  contentHash?: string;
  referenceSnapshot: TrashReferenceSnapshot;
  retentionDays?: number;
}): TrashRecord {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    deletedAt: input.deletedAt,
    expiresAt: computeExpiresAt(input.deletedAt, input.retentionDays),
    ...(input.latestRevision !== undefined ? { latestRevision: input.latestRevision } : {}),
    ...(input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
    referenceSnapshot: {
      referencedBy: [...input.referenceSnapshot.referencedBy],
      associations: {
        always: [...input.referenceSnapshot.associations.always],
        onDemand: [...input.referenceSnapshot.associations.onDemand],
      },
      boundHosts: [...input.referenceSnapshot.boundHosts],
    },
  };
}

/**
 * Plan how to re-apply environment→module associations from a trash snapshot.
 * Never overwrites associations created or changed after deletion.
 */
export function planRestoreAssociations(input: {
  kind: TrashObjectKind;
  snapshot: TrashReferenceSnapshot;
  availableModuleIds: ReadonlySet<string>;
  currentAssociations: {
    always: readonly string[];
    onDemand: readonly string[];
  };
}): RestoreAssociationResult[] {
  if (input.kind !== 'environment') return [];

  const currentAlways = new Set(input.currentAssociations.always);
  const currentOnDemand = new Set(input.currentAssociations.onDemand);
  const results: RestoreAssociationResult[] = [];

  const consider = (moduleId: string, mode: ModuleAssociationMode): void => {
    if (!input.availableModuleIds.has(moduleId)) {
      results.push({ moduleId, mode, status: 'skipped-missing' });
      return;
    }
    if (currentAlways.has(moduleId) || currentOnDemand.has(moduleId)) {
      const alreadyInMode = mode === 'always'
        ? currentAlways.has(moduleId)
        : currentOnDemand.has(moduleId);
      results.push({
        moduleId,
        mode,
        status: alreadyInMode ? 'already-present' : 'skipped-conflict',
      });
      return;
    }
    results.push({ moduleId, mode, status: 'restored' });
    if (mode === 'always') currentAlways.add(moduleId);
    else currentOnDemand.add(moduleId);
  };

  for (const moduleId of input.snapshot.associations.always) {
    consider(moduleId, 'always');
  }
  for (const moduleId of input.snapshot.associations.onDemand) {
    consider(moduleId, 'on_demand');
  }
  return results;
}

export function planPermanentDelete(input: {
  record: TrashRecord;
  now?: Date;
  agentActiveRevisions?: readonly number[];
}): PermanentDeletePreview {
  const now = input.now ?? new Date();
  const agentActive = input.agentActiveRevisions ?? [];
  const blockers: DeleteBlocker[] = [];
  if (
    input.record.latestRevision !== undefined
    && agentActive.includes(input.record.latestRevision)
  ) {
    blockers.push({
      code: 'agent-active',
      message:
        'Object revision is still pinned by an active Agent session and cannot be permanently deleted.',
    });
  }
  return {
    id: input.record.id,
    kind: input.record.kind,
    name: input.record.name,
    canPermanentlyDelete: blockers.length === 0,
    blockers,
    irreversible: true,
    expiresAt: input.record.expiresAt,
    daysRemaining: daysRemaining(input.record.expiresAt, now),
  };
}

export function selectExpiredTrashEntries(
  entries: readonly TrashRecord[],
  now: Date = new Date(),
): TrashRecord[] {
  return entries.filter((entry) => isExpired(entry.expiresAt, now));
}

export function emptyReferenceSnapshot(): TrashReferenceSnapshot {
  return {
    referencedBy: [],
    associations: { always: [], onDemand: [] },
    boundHosts: [],
  };
}
