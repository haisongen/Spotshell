/**
 * Pure helpers for detecting and classifying external edits to managed
 * knowledge object working trees. Storage I/O stays in KnowledgeRepository.
 */

import { createHash } from 'node:crypto';
import type { RevisionFileChange, RevisionFileSnapshot } from './revisionHistory.js';

/** Debounce window for coalescing rapid editor writes before rescan. */
export const EXTERNAL_EDIT_DEBOUNCE_MS = 500;

/** System / non-content paths that must never enter external-edit diffs. */
const SYSTEM_ROOT_FILES = new Set([
  'manifest.json',
  'draft.json',
  'file-origins.json',
  'external-baseline.json',
  'revision.json',
]);

const SYSTEM_ROOT_DIRS = new Set(['revisions', 'blobs', 'trash']);

export type ExternalFileChange = Exclude<RevisionFileChange, 'unchanged'> | 'renamed';

export interface ExternalFileDiff {
  relativePath: string;
  change: ExternalFileChange;
  /** Present when change is `renamed` — the path in the baseline tree. */
  previousPath?: string;
  leftSizeBytes?: number;
  rightSizeBytes?: number;
  leftContentHash?: string;
  rightContentHash?: string;
}

export interface ExternalContentDiff {
  hasChanges: boolean;
  files: ExternalFileDiff[];
  /** Stable fingerprint of the filtered working tree (sha256 hex). */
  workingContentHash: string;
}

/**
 * True for common editor swap/backup/lock files that must not become managed content.
 */
export function isEditorTemporaryPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const base = normalized.includes('/')
    ? normalized.slice(normalized.lastIndexOf('/') + 1)
    : normalized;

  if (!base) return true;
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return true;
  if (base.startsWith('.#') || (base.startsWith('#') && base.endsWith('#'))) return true;
  if (base.endsWith('~')) return true;
  if (base.startsWith('.') && (base.endsWith('.swp') || base.endsWith('.swo') || base.endsWith('.swn'))) {
    return true;
  }
  if (/\.(swp|swo|swn|tmp|temp|partial|bak|orig)$/i.test(base)) return true;
  if (normalized.includes('/__pycache__/') || normalized.startsWith('__pycache__/')) return true;
  if (normalized.includes('/.git/') || normalized.startsWith('.git/')) return true;
  return false;
}

/**
 * Keep only user-facing managed content paths for external-edit comparison.
 */
export function filterWorkingContentPaths(relativePaths: readonly string[]): string[] {
  return relativePaths
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => {
      if (!path || isEditorTemporaryPath(path)) return false;
      if (SYSTEM_ROOT_FILES.has(path)) return false;
      const top = path.split('/')[0] ?? path;
      if (SYSTEM_ROOT_DIRS.has(top)) return false;
      return true;
    })
    .sort(compareContentPaths);
}

/**
 * Watch relative paths under an object root. Ignore system dirs and temp files.
 * Accepts either object-root-relative (`draft-files/a.md`) or content-relative (`a.md`).
 */
export function shouldIgnoreExternalWatchEvent(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!normalized) return true;
  if (isEditorTemporaryPath(normalized)) return true;

  const segments = normalized.split('/');
  const top = segments[0] ?? '';
  if (SYSTEM_ROOT_DIRS.has(top)) return true;
  if (SYSTEM_ROOT_FILES.has(top) || SYSTEM_ROOT_FILES.has(normalized)) return true;

  // Under draft-files/, still ignore temp basenames.
  if (top === 'draft-files') {
    const rest = segments.slice(1).join('/');
    return !rest || isEditorTemporaryPath(rest);
  }

  return false;
}

/** Content-addressed fingerprint of a working tree (path + hash pairs). */
export function workingTreeFingerprint(files: readonly RevisionFileSnapshot[]): string {
  const sorted = [...files].sort((left, right) =>
    compareContentPaths(left.relativePath, right.relativePath),
  );
  const hash = createHash('sha256');
  for (const file of sorted) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.contentHash);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Compare a baseline tree (last app-known or last valid revision) to the current
 * working tree. Paired remove+add with identical content hash become renames.
 */
export function detectExternalContentDiff(
  baseline: readonly RevisionFileSnapshot[],
  working: readonly RevisionFileSnapshot[],
): ExternalContentDiff {
  const leftMap = new Map(baseline.map((file) => [file.relativePath, file]));
  const rightMap = new Map(working.map((file) => [file.relativePath, file]));
  const paths = [...new Set([...leftMap.keys(), ...rightMap.keys()])]
    .sort(compareContentPaths);

  const raw: ExternalFileDiff[] = [];
  for (const relativePath of paths) {
    const leftFile = leftMap.get(relativePath);
    const rightFile = rightMap.get(relativePath);
    if (leftFile && !rightFile) {
      raw.push({
        relativePath,
        change: 'removed',
        leftSizeBytes: leftFile.sizeBytes,
        leftContentHash: leftFile.contentHash,
      });
      continue;
    }
    if (!leftFile && rightFile) {
      raw.push({
        relativePath,
        change: 'added',
        rightSizeBytes: rightFile.sizeBytes,
        rightContentHash: rightFile.contentHash,
      });
      continue;
    }
    if (leftFile!.contentHash !== rightFile!.contentHash) {
      raw.push({
        relativePath,
        change: 'modified',
        leftSizeBytes: leftFile!.sizeBytes,
        rightSizeBytes: rightFile!.sizeBytes,
        leftContentHash: leftFile!.contentHash,
        rightContentHash: rightFile!.contentHash,
      });
    }
  }

  const files = collapseRenames(raw);
  return {
    hasChanges: files.length > 0,
    files,
    workingContentHash: workingTreeFingerprint(working),
  };
}

/** Origin label stored on revisions created by adopting external edits. */
export function externalOrigin(): string {
  return 'external';
}

function collapseRenames(diffs: readonly ExternalFileDiff[]): ExternalFileDiff[] {
  const removed = diffs.filter((diff) => diff.change === 'removed');
  const added = diffs.filter((diff) => diff.change === 'added');
  const rest = diffs.filter((diff) => diff.change !== 'removed' && diff.change !== 'added');

  const usedRemoved = new Set<string>();
  const usedAdded = new Set<string>();
  const renames: ExternalFileDiff[] = [];

  for (const add of added) {
    const match = removed.find((rem) =>
      !usedRemoved.has(rem.relativePath)
      && rem.leftContentHash
      && rem.leftContentHash === add.rightContentHash,
    );
    if (!match) continue;
    usedRemoved.add(match.relativePath);
    usedAdded.add(add.relativePath);
    renames.push({
      relativePath: add.relativePath,
      change: 'renamed',
      previousPath: match.relativePath,
      leftSizeBytes: match.leftSizeBytes,
      rightSizeBytes: add.rightSizeBytes,
      leftContentHash: match.leftContentHash,
      rightContentHash: add.rightContentHash,
    });
  }

  return [
    ...rest,
    ...renames,
    ...removed.filter((diff) => !usedRemoved.has(diff.relativePath)),
    ...added.filter((diff) => !usedAdded.has(diff.relativePath)),
  ].sort((left, right) => compareContentPaths(left.relativePath, right.relativePath));
}

function compareContentPaths(left: string, right: string): number {
  return left.toLocaleLowerCase('en-US').localeCompare(
    right.toLocaleLowerCase('en-US'),
    'en-US',
  ) || left.localeCompare(right, 'en-US');
}
