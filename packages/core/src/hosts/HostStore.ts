import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  FolderRemovalResult,
  HostFolder,
  HostFolderInput,
  HostProfile,
  HostProfileInput,
  HostTreeSnapshot,
} from './types.js';

interface HostFileShapeV2 {
  version: 2;
  folders: HostFolder[];
  hosts: HostProfile[];
}

const MAX_NOTES_LENGTH = 4000;
export const MAX_HOST_FOLDER_NAME_LENGTH = 100;

export class HostStore {
  constructor(private readonly filePath: string) {}

  list(): HostProfile[] {
    return this.read().hosts.slice();
  }

  getTree(): HostTreeSnapshot {
    const data = this.read();
    return { folders: data.folders.slice(), hosts: data.hosts.slice() };
  }

  listFolders(): HostFolder[] {
    return this.read().folders.slice();
  }

  add(input: HostProfileInput): HostProfile {
    const data = this.read();
    assertFolderExists(data, input.folderId);
    const profile: HostProfile = {
      id: input.id ?? randomUUID(),
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      privateKeyPath: input.privateKeyPath,
      authMethod: input.authMethod,
      notes: normalizeNotes(input.notes),
      folderId: input.folderId,
      environmentId: input.environmentId,
    };
    data.hosts.push(profile);
    this.write(data);
    return profile;
  }

  update(id: string, patch: Partial<HostProfileInput>): HostProfile {
    const data = this.read();
    const idx = data.hosts.findIndex((host) => host.id === id);
    if (idx < 0) throw new Error(`Host not found: ${id}`);
    if (Object.prototype.hasOwnProperty.call(patch, 'folderId')) {
      assertFolderExists(data, patch.folderId);
    }
    const current = data.hosts[idx]!;
    const next: HostProfile = { ...current, ...patch, id: current.id };
    next.notes = normalizeNotes(next.notes);
    data.hosts[idx] = next;
    this.write(data);
    return next;
  }

  /** Appends an AI-stamped note, unless doing so would exceed the notes limit. */
  appendNote(id: string, note: string, stamp: string): HostProfile | null {
    const current = this.get(id);
    if (!current) throw new Error(`Host not found: ${id}`);
    const entry = `[AI ${stamp}] ${note.trim()}`;
    const combined = current.notes ? `${current.notes}\n\n${entry}` : entry;
    if (combined.length > MAX_NOTES_LENGTH) return null;
    return this.update(id, { notes: combined });
  }

  remove(id: string): void {
    const data = this.read();
    data.hosts = data.hosts.filter((host) => host.id !== id);
    this.write(data);
  }

  get(id: string): HostProfile | undefined {
    return this.read().hosts.find((host) => host.id === id);
  }

  listByEnvironmentId(environmentId: string): HostProfile[] {
    return this.read().hosts.filter((host) => host.environmentId === environmentId);
  }

  addFolder(input: HostFolderInput): HostFolder {
    const data = this.read();
    const name = normalizeFolderName(input.name);
    assertFolderExists(data, input.parentId);
    assertUniqueSiblingName(data.folders, input.parentId, name);
    const folder: HostFolder = { id: randomUUID(), name, parentId: input.parentId };
    data.folders.push(folder);
    this.write(data);
    return folder;
  }

  renameFolder(id: string, name: string): HostFolder {
    const data = this.read();
    const folder = data.folders.find((entry) => entry.id === id);
    if (!folder) throw new Error(`Folder not found: ${id}`);
    const normalizedName = normalizeFolderName(name);
    assertUniqueSiblingName(data.folders, folder.parentId, normalizedName, id);
    folder.name = normalizedName;
    this.write(data);
    return { ...folder };
  }

  removeFolder(id: string): FolderRemovalResult {
    const data = this.read();
    const folder = data.folders.find((entry) => entry.id === id);
    if (!folder) throw new Error(`Folder not found: ${id}`);

    const childFolders = data.folders.filter((entry) => entry.parentId === id);
    for (const child of childFolders) {
      assertUniqueSiblingName(data.folders, folder.parentId, child.name, id, new Set(childFolders.map((entry) => entry.id)));
    }

    const directHosts = data.hosts.filter((host) => host.folderId === id);
    for (const child of childFolders) child.parentId = folder.parentId;
    for (const host of directHosts) host.folderId = folder.parentId;
    data.folders = data.folders.filter((entry) => entry.id !== id);
    this.write(data);

    return {
      removedFolderId: id,
      parentId: folder.parentId,
      movedHostCount: directHosts.length,
      movedFolderCount: childFolders.length,
    };
  }

  moveHost(hostId: string, folderId?: string): HostProfile {
    const data = this.read();
    const host = data.hosts.find((entry) => entry.id === hostId);
    if (!host) throw new Error(`Host not found: ${hostId}`);
    assertFolderExists(data, folderId);
    host.folderId = folderId;
    this.write(data);
    return { ...host };
  }

  private read(): HostFileShapeV2 {
    if (!fs.existsSync(this.filePath)) return { version: 2, folders: [], hosts: [] };
    const decoded: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    const parsed = isRecord(decoded) ? decoded : {};
    const folders = sanitizeFolders(parsed.version === 2 ? parsed.folders : []);
    const folderIds = new Set(folders.map((folder) => folder.id));
    const rawHosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
    const hosts = rawHosts
      .filter(isHostRecord)
      .map((host) => sanitizeHost(host, parsed.version === 2 ? folderIds : new Set()));
    return { version: 2, folders, hosts };
  }

  private write(data: HostFileShapeV2): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const folders = sanitizeFolders(data.folders);
    const folderIds = new Set(folders.map((folder) => folder.id));
    const safe: HostFileShapeV2 = {
      version: 2,
      folders,
      hosts: data.hosts.map((host) => sanitizeHost(host, folderIds)),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(safe, null, 2), 'utf8');
  }
}

function normalizeFolderName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error('Folder name must not be empty');
  if (normalized.length > MAX_HOST_FOLDER_NAME_LENGTH) {
    throw new Error(`Folder name must not exceed ${MAX_HOST_FOLDER_NAME_LENGTH} characters`);
  }
  return normalized;
}

function assertFolderExists(data: HostFileShapeV2, folderId?: string): void {
  if (folderId !== undefined && !data.folders.some((folder) => folder.id === folderId)) {
    throw new Error(`Folder not found: ${folderId}`);
  }
}

function assertUniqueSiblingName(
  folders: HostFolder[],
  parentId: string | undefined,
  name: string,
  ignoredId?: string,
  additionalIgnoredIds: Set<string> = new Set(),
): void {
  const conflict = folders.some((folder) =>
    folder.id !== ignoredId
    && !additionalIgnoredIds.has(folder.id)
    && folder.parentId === parentId
    && folder.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
  );
  if (conflict) throw new Error(`A folder named "${name}" already exists in this directory`);
}

function sanitizeFolders(value: unknown): HostFolder[] {
  if (!Array.isArray(value)) return [];
  const folders: HostFolder[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') continue;
    const name = item.name.trim();
    if (!name || name.length > MAX_HOST_FOLDER_NAME_LENGTH || ids.has(item.id)) continue;
    ids.add(item.id);
    folders.push({
      id: item.id,
      name,
      parentId: typeof item.parentId === 'string' && item.parentId ? item.parentId : undefined,
    });
  }

  const knownIds = new Set(folders.map((folder) => folder.id));
  for (const folder of folders) {
    if (folder.parentId !== undefined && !knownIds.has(folder.parentId)) folder.parentId = undefined;
  }
  const cyclicIds = new Set(folders.filter((folder) => hasParentCycle(folder, folders)).map((folder) => folder.id));
  for (const folder of folders) if (cyclicIds.has(folder.id)) folder.parentId = undefined;
  return folders;
}

function hasParentCycle(start: HostFolder, folders: HostFolder[]): boolean {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const visited = new Set([start.id]);
  let parentId = start.parentId;
  while (parentId !== undefined) {
    if (visited.has(parentId)) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

function sanitizeHost(value: unknown, folderIds: Set<string>): HostProfile {
  const host = value as HostProfile;
  return {
    id: host.id,
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    privateKeyPath: host.privateKeyPath,
    authMethod: host.authMethod,
    notes: normalizeNotes(host.notes),
    folderId: typeof host.folderId === 'string' && folderIds.has(host.folderId) ? host.folderId : undefined,
    environmentId: typeof host.environmentId === 'string' && host.environmentId
      ? host.environmentId
      : undefined,
  };
}

function isHostRecord(value: unknown): value is HostProfile {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.host === 'string'
    && typeof value.port === 'number'
    && typeof value.username === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeNotes(notes: unknown): string | undefined {
  return typeof notes === 'string' && notes.trim() ? notes : undefined;
}
