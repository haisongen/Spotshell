/**
 * Pure helpers for valid-revision history: protection marking, file compare,
 * cleanup planning, and content-addressed blob reference accounting.
 * Storage I/O stays in KnowledgeRepository.
 */

export type RevisionProtectionReason =
  | 'current-effective'
  | 'agent-active'
  | 'proposal-target'
  | 'recovery-required';

/** External pins that keep a historical revision from cleanup. */
export interface RevisionProtectionInput {
  /** Latest valid (effective) revision number for the object. */
  latestRevision?: number;
  /** Revisions currently pinned by any live Agent session. */
  agentActiveRevisions?: readonly number[];
  /** Revisions targeted by pending AI proposals. */
  proposalTargetRevisions?: readonly number[];
  /** Revisions required to restore trash / recovery relationships. */
  recoveryRequiredRevisions?: readonly number[];
}

export interface RevisionHistoryEntry {
  id: string;
  revision: number;
  contentHash: string;
  createdAt: string;
  /** How the revision was created (publish, restore:N, import, …). */
  origin: string;
  isCurrentEffective: boolean;
  isAgentActive: boolean;
  protectionReasons: RevisionProtectionReason[];
  /** Bytes of exclusive blob content not shared with other surviving revisions. */
  exclusiveBytes: number;
  /** Total materialised bytes of this revision's object files (excludes revision.json). */
  sizeBytes: number;
}

export interface RevisionFileSnapshot {
  relativePath: string;
  content: string;
  sizeBytes: number;
  contentHash: string;
}

export type RevisionFileChange = 'added' | 'removed' | 'modified' | 'unchanged';

export interface RevisionFileDiff {
  relativePath: string;
  change: RevisionFileChange;
  leftSizeBytes?: number;
  rightSizeBytes?: number;
  leftContentHash?: string;
  rightContentHash?: string;
}

export interface RevisionComparison {
  objectId: string;
  leftRevision: number;
  rightRevision: number;
  leftContentHash: string;
  rightContentHash: string;
  entryChanged: boolean;
  files: RevisionFileDiff[];
}

export interface RevisionCleanupPreview {
  objectId: string;
  requestedRevisions: number[];
  removableRevisions: number[];
  blockedRevisions: Array<{
    revision: number;
    reasons: RevisionProtectionReason[];
  }>;
  /** Estimated bytes reclaimed after GC of exclusive content. */
  estimatedFreedBytes: number;
  irreversible: true;
}

export interface BlobReference {
  contentHash: string;
  sizeBytes: number;
  /** Revision numbers that reference this blob. */
  revisions: readonly number[];
}

/**
 * Reasons a revision cannot be cleaned up under the given protection context.
 * Latest effective, agent-active, proposal targets, and recovery pins are protected.
 */
export function protectionReasonsForRevision(
  revision: number,
  protection: RevisionProtectionInput,
): RevisionProtectionReason[] {
  const reasons: RevisionProtectionReason[] = [];
  if (protection.latestRevision === revision) {
    reasons.push('current-effective');
  }
  if ((protection.agentActiveRevisions ?? []).includes(revision)) {
    reasons.push('agent-active');
  }
  if ((protection.proposalTargetRevisions ?? []).includes(revision)) {
    reasons.push('proposal-target');
  }
  if ((protection.recoveryRequiredRevisions ?? []).includes(revision)) {
    reasons.push('recovery-required');
  }
  return reasons;
}

export function isRevisionProtected(
  revision: number,
  protection: RevisionProtectionInput,
): boolean {
  return protectionReasonsForRevision(revision, protection).length > 0;
}

/**
 * Build list-row markers for a stored revision metadata row.
 */
export function annotateRevisionHistoryEntry(input: {
  id: string;
  revision: number;
  contentHash: string;
  createdAt: string;
  origin: string;
  sizeBytes: number;
  exclusiveBytes: number;
  protection: RevisionProtectionInput;
}): RevisionHistoryEntry {
  const protectionReasons = protectionReasonsForRevision(input.revision, input.protection);
  return {
    id: input.id,
    revision: input.revision,
    contentHash: input.contentHash,
    createdAt: input.createdAt,
    origin: input.origin,
    isCurrentEffective: protectionReasons.includes('current-effective'),
    isAgentActive: protectionReasons.includes('agent-active'),
    protectionReasons,
    exclusiveBytes: input.exclusiveBytes,
    sizeBytes: input.sizeBytes,
  };
}

/**
 * Compare two revision file snapshots. Paths are object-relative; SPACE.md is the entry.
 */
export function compareRevisionFiles(
  left: readonly RevisionFileSnapshot[],
  right: readonly RevisionFileSnapshot[],
): RevisionFileDiff[] {
  const leftMap = new Map(left.map((file) => [file.relativePath, file]));
  const rightMap = new Map(right.map((file) => [file.relativePath, file]));
  const paths = [...new Set([...leftMap.keys(), ...rightMap.keys()])]
    .sort((a, b) => a.localeCompare(b, 'en-US'));

  return paths.map((relativePath) => {
    const leftFile = leftMap.get(relativePath);
    const rightFile = rightMap.get(relativePath);
    if (leftFile && !rightFile) {
      return {
        relativePath,
        change: 'removed' as const,
        leftSizeBytes: leftFile.sizeBytes,
        leftContentHash: leftFile.contentHash,
      };
    }
    if (!leftFile && rightFile) {
      return {
        relativePath,
        change: 'added' as const,
        rightSizeBytes: rightFile.sizeBytes,
        rightContentHash: rightFile.contentHash,
      };
    }
    const same = leftFile!.contentHash === rightFile!.contentHash;
    return {
      relativePath,
      change: same ? 'unchanged' as const : 'modified' as const,
      leftSizeBytes: leftFile!.sizeBytes,
      rightSizeBytes: rightFile!.sizeBytes,
      leftContentHash: leftFile!.contentHash,
      rightContentHash: rightFile!.contentHash,
    };
  });
}

export function buildRevisionComparison(input: {
  objectId: string;
  leftRevision: number;
  rightRevision: number;
  leftContentHash: string;
  rightContentHash: string;
  leftFiles: readonly RevisionFileSnapshot[];
  rightFiles: readonly RevisionFileSnapshot[];
}): RevisionComparison {
  const files = compareRevisionFiles(input.leftFiles, input.rightFiles);
  const entry = files.find((file) => file.relativePath === 'SPACE.md');
  return {
    objectId: input.objectId,
    leftRevision: input.leftRevision,
    rightRevision: input.rightRevision,
    leftContentHash: input.leftContentHash,
    rightContentHash: input.rightContentHash,
    entryChanged: entry ? entry.change !== 'unchanged' : true,
    files,
  };
}

/**
 * Plan an explicit cleanup. Protected revisions are blocked; estimated free space
 * only counts exclusive blob bytes that become unreferenced after the removal set.
 */
export function planRevisionCleanup(input: {
  objectId: string;
  requestedRevisions: readonly number[];
  availableRevisions: readonly number[];
  protection: RevisionProtectionInput;
  blobReferences: readonly BlobReference[];
}): RevisionCleanupPreview {
  const available = new Set(input.availableRevisions);
  const requested = [...new Set(input.requestedRevisions)]
    .filter((revision) => available.has(revision))
    .sort((a, b) => a - b);

  const blockedRevisions: RevisionCleanupPreview['blockedRevisions'] = [];
  const removableRevisions: number[] = [];

  for (const revision of requested) {
    const reasons = protectionReasonsForRevision(revision, input.protection);
    if (reasons.length > 0) {
      blockedRevisions.push({ revision, reasons });
    } else {
      removableRevisions.push(revision);
    }
  }

  const removableSet = new Set(removableRevisions);
  let estimatedFreedBytes = 0;
  for (const blob of input.blobReferences) {
    const remaining = blob.revisions.filter((revision) => !removableSet.has(revision));
    if (remaining.length === 0 && blob.revisions.some((revision) => removableSet.has(revision))) {
      estimatedFreedBytes += blob.sizeBytes;
    }
  }

  return {
    objectId: input.objectId,
    requestedRevisions: requested,
    removableRevisions,
    blockedRevisions,
    estimatedFreedBytes,
    irreversible: true,
  };
}

/**
 * Bytes exclusive to a single revision given global blob reference counts.
 */
export function exclusiveBytesForRevision(
  revision: number,
  blobReferences: readonly BlobReference[],
): number {
  let total = 0;
  for (const blob of blobReferences) {
    if (blob.revisions.length === 1 && blob.revisions[0] === revision) {
      total += blob.sizeBytes;
    }
  }
  return total;
}

/**
 * Reject cleanup when any requested revision is protected or missing.
 * Callers should surface the preview instead of partially deleting.
 */
export function assertCleanupAllowed(preview: RevisionCleanupPreview): void {
  if (preview.blockedRevisions.length > 0) {
    const details = preview.blockedRevisions
      .map((entry) => `r${entry.revision}(${entry.reasons.join(',')})`)
      .join(', ');
    throw new Error(`Cannot clean up protected revisions: ${details}`);
  }
  if (preview.removableRevisions.length === 0) {
    throw new Error('No removable revisions selected for cleanup');
  }
  if (preview.removableRevisions.length !== preview.requestedRevisions.length) {
    throw new Error('One or more requested revisions are not available');
  }
}

/** Default free-space floor before creating a new valid revision (50 MiB). */
export const DEFAULT_MIN_FREE_DISK_BYTES = 50 * 1024 * 1024;

/**
 * Actionable error when disk space (or injected quota) is insufficient.
 * Callers must not silently prune history to complete a save.
 */
export function diskSpaceInsufficientError(
  freeBytes: number,
  requiredBytes: number,
): Error {
  return new Error(
    `Insufficient disk space to create a new knowledge revision `
    + `(free ${freeBytes} bytes, need at least ${requiredBytes} bytes). `
    + `Free space or explicitly clean up old revisions before saving.`,
  );
}

export function assertEnoughDiskSpace(input: {
  freeBytes: number;
  minFreeBytes?: number;
  /** Approximate bytes the new revision will write before dedup. */
  estimatedWriteBytes?: number;
}): void {
  const minFree = input.minFreeBytes ?? DEFAULT_MIN_FREE_DISK_BYTES;
  const required = Math.max(minFree, input.estimatedWriteBytes ?? 0);
  if (input.freeBytes < required) {
    throw diskSpaceInsufficientError(input.freeBytes, required);
  }
}

/** Origin labels written into revision.json. */
export function publishOrigin(): string {
  return 'publish';
}

export function restoreOrigin(fromRevision: number): string {
  return `restore:${fromRevision}`;
}

/** Origin for revisions created by accepting an AI knowledge proposal. */
export function proposalOrigin(): string {
  return 'ai-proposal';
}

export function normalizeRevisionOrigin(origin: string | undefined): string {
  if (!origin || !origin.trim()) return publishOrigin();
  return origin.trim();
}
