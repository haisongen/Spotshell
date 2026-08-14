/**
 * Pure helpers for AI knowledge change proposals (ADR-040).
 * Agent tools only create proposals; accept/write lives in the host application.
 */

import { extractGuidanceBody } from './spaceDocument.js';
import { buildUnifiedDiff } from './unifiedDiff.js';

export type KnowledgeProposalTargetKind = 'host-notes' | 'environment' | 'knowledge';

export type KnowledgeProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'conflict'
  | 'validation-failed';

export interface KnowledgeProposalFileChange {
  relativePath: string;
  before: string;
  after: string;
}

export interface KnowledgeProposalSource {
  objectId: string;
  objectName: string;
  objectKind?: KnowledgeProposalTargetKind;
  revision?: number;
  contentHash?: string;
  relativePath?: string;
  startLine?: number;
  endLine?: number;
}

export interface KnowledgeProposalConflict {
  currentRevision: number;
  currentContentHash: string;
}

export interface KnowledgeChangeProposal {
  id: string;
  targetKind: KnowledgeProposalTargetKind;
  targetId: string;
  targetName: string;
  baseRevision: number;
  baseContentHash: string;
  files: KnowledgeProposalFileChange[];
  reason: string;
  /** Terminal output used only as evidence — never auto-written as knowledge. */
  terminalEvidence: string;
  knowledgeSources: KnowledgeProposalSource[];
  /**
   * User-only flag. Elevating reference content into Guidance requires explicit
   * consent; the Agent create path always leaves this false.
   */
  promoteToGuidance: boolean;
  status: KnowledgeProposalStatus;
  createdAt: string;
  validationError?: string;
  conflict?: KnowledgeProposalConflict;
}

export interface CreateKnowledgeProposalInput {
  id: string;
  targetKind: KnowledgeProposalTargetKind;
  targetId: string;
  targetName: string;
  baseRevision: number;
  baseContentHash: string;
  files: readonly KnowledgeProposalFileChange[];
  reason: string;
  terminalEvidence?: string;
  knowledgeSources?: readonly KnowledgeProposalSource[];
  createdAt: string;
  /** Ignored on create — Agent cannot enable Guidance promotion. */
  promoteToGuidance?: boolean;
}

export type CreateKnowledgeProposalResult =
  | { ok: true; proposal: KnowledgeChangeProposal }
  | { ok: false; error: string };

export type EditKnowledgeProposalResult =
  | { ok: true; proposal: KnowledgeChangeProposal }
  | { ok: false; error: string };

export type PrepareAcceptKnowledgeProposalResult =
  | { ok: true; proposal: KnowledgeChangeProposal }
  | {
    ok: false;
    reason: 'stale' | 'not-pending' | 'no-changes' | 'guidance-promotion-required' | 'invalid';
    proposal: KnowledgeChangeProposal;
    error?: string;
  };

export interface ProposalBaseSnapshot {
  revision: number;
  contentHash: string;
}

const HOST_NOTES_PATH = 'notes';

/**
 * Validate and freeze a pending single-target knowledge proposal.
 * Always forces `promoteToGuidance` to false (user must opt in later).
 */
export function createKnowledgeProposal(
  input: CreateKnowledgeProposalInput,
): CreateKnowledgeProposalResult {
  const error = validateProposalShape(input);
  if (error) return { ok: false, error };

  return {
    ok: true,
    proposal: {
      id: input.id.trim(),
      targetKind: input.targetKind,
      targetId: input.targetId.trim(),
      targetName: input.targetName.trim() || defaultTargetName(input.targetKind),
      baseRevision: input.baseRevision,
      baseContentHash: input.baseContentHash.trim(),
      files: normalizeFiles(input.files),
      reason: input.reason.trim(),
      terminalEvidence: (input.terminalEvidence ?? '').trim(),
      knowledgeSources: (input.knowledgeSources ?? []).map(normalizeSource),
      promoteToGuidance: false,
      status: 'pending',
      createdAt: input.createdAt,
    },
  };
}

/** User edits while the proposal is still pending (or conflict after re-review). */
export function editKnowledgeProposal(
  proposal: KnowledgeChangeProposal,
  patch: {
    reason?: string;
    terminalEvidence?: string;
    files?: readonly KnowledgeProposalFileChange[];
    promoteToGuidance?: boolean;
  },
): EditKnowledgeProposalResult {
  if (
    proposal.status !== 'pending'
    && proposal.status !== 'conflict'
    && proposal.status !== 'validation-failed'
  ) {
    return { ok: false, error: 'Only pending, conflict, or validation-failed proposals can be edited' };
  }

  const nextFiles = patch.files ? normalizeFiles(patch.files) : proposal.files;
  const nextReason = patch.reason !== undefined ? patch.reason.trim() : proposal.reason;
  const nextEvidence = patch.terminalEvidence !== undefined
    ? patch.terminalEvidence.trim()
    : proposal.terminalEvidence;

  if (!nextReason) return { ok: false, error: 'Proposal reason is required' };
  if (nextFiles.length === 0) return { ok: false, error: 'Proposal must include at least one file change' };
  if (!nextFiles.some((file) => file.before !== file.after)) {
    return { ok: false, error: 'Proposal must change at least one file' };
  }
  for (const file of nextFiles) {
    const pathError = assertSafeRelativePath(file.relativePath, proposal.targetKind);
    if (pathError) return { ok: false, error: pathError };
  }

  return {
    ok: true,
    proposal: {
      ...proposal,
      reason: nextReason,
      terminalEvidence: nextEvidence,
      files: nextFiles,
      promoteToGuidance: patch.promoteToGuidance ?? proposal.promoteToGuidance,
      // Editing after a conflict returns the card to pending for re-review.
      status: 'pending',
      conflict: undefined,
      validationError: undefined,
    },
  };
}

export function cancelKnowledgeProposal(
  proposal: KnowledgeChangeProposal,
): KnowledgeChangeProposal {
  if (proposal.status !== 'pending' && proposal.status !== 'conflict') {
    return proposal;
  }
  return {
    ...proposal,
    status: 'cancelled',
    conflict: undefined,
  };
}

export function rejectKnowledgeProposal(
  proposal: KnowledgeChangeProposal,
): KnowledgeChangeProposal {
  if (proposal.status !== 'pending' && proposal.status !== 'conflict') {
    return proposal;
  }
  return {
    ...proposal,
    status: 'rejected',
    conflict: undefined,
  };
}

export function checkProposalBase(
  proposal: Pick<KnowledgeChangeProposal, 'baseRevision' | 'baseContentHash'>,
  current: ProposalBaseSnapshot,
): 'ok' | 'stale' {
  if (
    current.revision === proposal.baseRevision
    && current.contentHash === proposal.baseContentHash
  ) {
    return 'ok';
  }
  return 'stale';
}

/**
 * Re-check base revision/hash and Guidance promotion before any write pipeline runs.
 * Does not persist knowledge; host applies the result through the normal draft/publish path.
 */
export function prepareAcceptKnowledgeProposal(
  proposal: KnowledgeChangeProposal,
  current: ProposalBaseSnapshot,
): PrepareAcceptKnowledgeProposalResult {
  if (
    proposal.status !== 'pending'
    && proposal.status !== 'conflict'
    && proposal.status !== 'validation-failed'
  ) {
    return {
      ok: false,
      reason: 'not-pending',
      proposal,
      error: `Proposal is ${proposal.status} and cannot be accepted`,
    };
  }

  if (!proposal.files.some((file) => file.before !== file.after)) {
    return {
      ok: false,
      reason: 'no-changes',
      proposal: {
        ...proposal,
        status: 'validation-failed',
        validationError: 'Proposal has no file changes',
      },
      error: 'Proposal has no file changes',
    };
  }

  if (checkProposalBase(proposal, current) === 'stale') {
    const conflicted: KnowledgeChangeProposal = {
      ...proposal,
      status: 'conflict',
      conflict: {
        currentRevision: current.revision,
        currentContentHash: current.contentHash,
      },
    };
    return {
      ok: false,
      reason: 'stale',
      proposal: conflicted,
      error: 'Target revision changed; re-review the proposal against the new base',
    };
  }

  if (
    proposal.targetKind === 'knowledge'
    && proposalChangesGuidance(proposal.files)
    && !proposal.promoteToGuidance
  ) {
    return {
      ok: false,
      reason: 'guidance-promotion-required',
      proposal,
      error: 'Promoting content to Guidance requires explicit user confirmation',
    };
  }

  if (proposal.targetKind === 'environment' && proposalChangesGuidance(proposal.files)) {
    return {
      ok: false,
      reason: 'invalid',
      proposal: {
        ...proposal,
        status: 'validation-failed',
        validationError: 'Environment profiles cannot contain Guidance',
      },
      error: 'Environment profiles cannot contain Guidance',
    };
  }

  return {
    ok: true,
    proposal: {
      ...proposal,
      status: 'pending',
      conflict: undefined,
      validationError: undefined,
    },
  };
}

/**
 * True when Guidance-scoped content would change: SPACE.md ## Guidance body,
 * guidance_files whitelist, or any file listed in before/after guidance_files.
 */
export function proposalChangesGuidance(
  files: readonly KnowledgeProposalFileChange[],
): boolean {
  const guidancePaths = new Set<string>();
  for (const file of files) {
    if (file.relativePath === 'SPACE.md') {
      if (extractGuidanceBody(file.before) !== extractGuidanceBody(file.after)) {
        return true;
      }
      if (extractGuidanceFilesYaml(file.before) !== extractGuidanceFilesYaml(file.after)) {
        return true;
      }
      for (const path of listGuidanceFiles(file.before)) guidancePaths.add(path);
      for (const path of listGuidanceFiles(file.after)) guidancePaths.add(path);
    }
  }
  for (const file of files) {
    if (guidancePaths.has(file.relativePath) && file.before !== file.after) {
      return true;
    }
  }
  return false;
}

/** Rebase a conflicted proposal onto a new base snapshot for re-review. */
export function rebaseKnowledgeProposal(
  proposal: KnowledgeChangeProposal,
  base: {
    revision: number;
    contentHash: string;
    files: readonly KnowledgeProposalFileChange[];
  },
): EditKnowledgeProposalResult {
  if (proposal.status !== 'conflict' && proposal.status !== 'pending') {
    return { ok: false, error: 'Only pending or conflict proposals can be rebased' };
  }
  const files = normalizeFiles(base.files);
  if (files.length === 0) return { ok: false, error: 'Rebase requires file snapshots' };
  for (const file of files) {
    const pathError = assertSafeRelativePath(file.relativePath, proposal.targetKind);
    if (pathError) return { ok: false, error: pathError };
  }
  return {
    ok: true,
    proposal: {
      ...proposal,
      baseRevision: base.revision,
      baseContentHash: base.contentHash,
      files,
      status: 'pending',
      conflict: undefined,
      validationError: undefined,
    },
  };
}

/** Build a reviewable git-style unified diff for Chat review. */
export function buildProposalUnifiedDiff(proposal: KnowledgeChangeProposal): string {
  return proposal.files
    .filter((file) => file.before !== file.after)
    .map((file) => buildUnifiedDiff(file.relativePath, file.before, file.after))
    .join('\n');
}

/** After contents only, for applying a proposal onto the object working tree. */
export function proposedFileContents(
  proposal: KnowledgeChangeProposal,
): Array<{ relativePath: string; content: string }> {
  return proposal.files.map((file) => ({
    relativePath: file.relativePath,
    content: file.after,
  }));
}

function validateProposalShape(input: CreateKnowledgeProposalInput): string | undefined {
  if (!input.id?.trim()) return 'Proposal id is required';
  if (!input.targetId?.trim()) return 'Proposal target id is required';
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
    return 'Proposal base revision must be a non-negative integer';
  }
  if (!input.baseContentHash?.trim()) return 'Proposal base content hash is required';
  if (!input.reason?.trim()) return 'Proposal reason is required';
  if (!input.files || input.files.length === 0) {
    return 'Proposal must include at least one file change';
  }
  if (!['host-notes', 'environment', 'knowledge'].includes(input.targetKind)) {
    return 'Proposal target kind is invalid';
  }

  const normalized = normalizeFiles(input.files);
  if (!normalized.some((file) => file.before !== file.after)) {
    return 'Proposal must change at least one file';
  }
  for (const file of normalized) {
    const pathError = assertSafeRelativePath(file.relativePath, input.targetKind);
    if (pathError) return pathError;
  }

  if (input.targetKind === 'host-notes') {
    if (normalized.length !== 1 || normalized[0]!.relativePath !== HOST_NOTES_PATH) {
      return 'Host Notes proposals must target the single notes path';
    }
  }

  return undefined;
}

function normalizeFiles(
  files: readonly KnowledgeProposalFileChange[],
): KnowledgeProposalFileChange[] {
  return files.map((file) => ({
    relativePath: normalizeRelativePath(file.relativePath),
    before: file.before ?? '',
    after: file.after ?? '',
  }));
}

function normalizeSource(source: KnowledgeProposalSource): KnowledgeProposalSource {
  return {
    objectId: source.objectId,
    objectName: source.objectName,
    ...(source.objectKind ? { objectKind: source.objectKind } : {}),
    ...(source.revision !== undefined ? { revision: source.revision } : {}),
    ...(source.contentHash ? { contentHash: source.contentHash } : {}),
    ...(source.relativePath ? { relativePath: source.relativePath } : {}),
    ...(source.startLine !== undefined ? { startLine: source.startLine } : {}),
    ...(source.endLine !== undefined ? { endLine: source.endLine } : {}),
  };
}

function defaultTargetName(kind: KnowledgeProposalTargetKind): string {
  if (kind === 'host-notes') return 'Host Notes';
  if (kind === 'environment') return 'Environment';
  return 'Knowledge module';
}

function assertSafeRelativePath(
  relativePath: string,
  targetKind: KnowledgeProposalTargetKind,
): string | undefined {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return 'File path is required';
  if (normalized !== relativePath.replace(/\\/g, '/').replace(/^\.?\//, '')) {
    return `Unsafe path: ${relativePath}`;
  }
  if (
    normalized.includes('..')
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
  ) {
    return `Unsafe path: ${relativePath}`;
  }
  if (targetKind === 'host-notes' && normalized !== HOST_NOTES_PATH) {
    return 'Host Notes proposals must use relative path "notes"';
  }
  if (targetKind !== 'host-notes' && normalized === HOST_NOTES_PATH) {
    return 'Managed objects cannot use the Host Notes path';
  }
  return undefined;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
}

function extractGuidanceFilesYaml(source: string): string {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return '';
  const yaml = frontmatter[1]!;
  const block = yaml.match(/^guidance_files:\s*\n((?:[ \t]+-.*\n?)*)/m)
    ?? yaml.match(/^guidance_files:\s*(\[[^\]]*\])/m);
  return (block?.[0] ?? '').trim();
}

function listGuidanceFiles(source: string): string[] {
  const yamlBlock = extractGuidanceFilesYaml(source);
  if (!yamlBlock) return [];
  const paths: string[] = [];
  for (const match of yamlBlock.matchAll(/-\s+(.+)$/gm)) {
    const value = match[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (value) paths.push(normalizeRelativePath(value));
  }
  for (const match of yamlBlock.matchAll(/['"]([^'"]+)['"]/g)) {
    const value = match[1]?.trim();
    if (value && value !== 'guidance_files') paths.push(normalizeRelativePath(value));
  }
  return [...new Set(paths)];
}

