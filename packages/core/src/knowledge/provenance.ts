export type KnowledgeContentType =
  | 'entry'
  | 'guidance'
  | 'reference'
  | 'metadata'
  | 'search-preview';

export type KnowledgeLoadReason =
  | 'fixed'
  | 'environment-default'
  | 'dynamic'
  | 'search'
  | 'line-read'
  | 'entry-read';

export interface KnowledgeProvenanceRecord {
  objectId: string;
  objectName: string;
  objectKind: 'environment' | 'knowledge';
  revision: number;
  contentHash: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  contentType: KnowledgeContentType;
  loadReason: KnowledgeLoadReason;
}

export function loadReasonForAccess(
  access: 'environment' | 'fixed' | 'dynamic'
): KnowledgeLoadReason {
  if (access === 'environment') return 'environment-default';
  if (access === 'fixed') return 'fixed';
  return 'dynamic';
}
