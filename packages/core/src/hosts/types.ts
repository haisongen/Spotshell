/** How much care a host needs; drives the colour cue shown on its sessions. */
export const HOST_TIERS = ['production', 'staging', 'testing', 'development'] as const;
export type HostTier = (typeof HOST_TIERS)[number];

export interface HostProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  /** Never persisted as password value; reserved for UI auth preference only */
  authMethod?: 'key' | 'password' | 'agent';
  /** 用户手写的环境备注（如 "CDH 6.3 集群，Kerberos 认证"），注入该主机会话的 AI 上下文 */
  notes?: string;
  /** undefined means the system root directory */
  folderId?: string;
  /** Stable environment profile id used as this saved host's local default. */
  environmentId?: string;
  /** Deployment tier; undefined means unmarked. */
  tier?: HostTier;
}

export type HostProfileInput = Omit<HostProfile, 'id'> & { id?: string };

export interface HostFolder {
  id: string;
  name: string;
  /** undefined means the system root directory */
  parentId?: string;
}

export interface HostFolderInput {
  name: string;
  /** undefined means the system root directory */
  parentId?: string;
}

export interface HostTreeSnapshot {
  folders: HostFolder[];
  hosts: HostProfile[];
}

export interface FolderRemovalResult {
  removedFolderId: string;
  /** The directory that received the removed folder's direct contents. */
  parentId?: string;
  movedHostCount: number;
  movedFolderCount: number;
}
