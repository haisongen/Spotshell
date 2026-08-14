import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  SafeObjectRoot,
  normalizeRelativePath,
  type ManagedTextFile,
} from './safeObjectRoot.js';
import {
  parseSpaceDocument,
  serializeSpaceDocument,
  type SpaceDocument,
} from './spaceDocument.js';

export interface LoadedSpaceObject {
  document: SpaceDocument;
  files: ManagedTextFile[];
  contentHash: string;
}

export async function loadSpaceObject(rootPath: string): Promise<LoadedSpaceObject> {
  const root = await SafeObjectRoot.open(rootPath);
  const files = await root.listTextFiles();
  const entry = files.find((file) => file.relativePath === 'SPACE.md');
  if (!entry) throw new Error('Knowledge object must contain SPACE.md at its root');
  const document = parseSpaceDocument(entry.content);

  if (document.metadata.kind === 'knowledge') {
    validateGuidanceFiles(document.metadata.guidance_files ?? [], files);
  }

  return {
    document,
    files,
    contentHash: hashFiles(files, document),
  };
}

function validateGuidanceFiles(
  guidanceFiles: readonly string[],
  files: readonly ManagedTextFile[]
): void {
  const knownPaths = new Set(files.map((file) => file.relativePath));
  for (const guidancePath of guidanceFiles) {
    const normalizedPath = normalizeRelativePath(guidancePath);
    const extension = path.posix.extname(normalizedPath).toLocaleLowerCase('en-US');
    if (extension !== '.md' && extension !== '.txt') {
      throw new Error(`Guidance file must be Markdown or text: ${normalizedPath}`);
    }
    if (!knownPaths.has(normalizedPath)) {
      throw new Error(`Guidance file does not exist: ${normalizedPath}`);
    }
  }
}

function hashFiles(files: readonly ManagedTextFile[], document: SpaceDocument): string {
  const hash = createHash('sha256');
  for (const file of files) {
    const content = file.relativePath === 'SPACE.md'
      ? serializeSpaceDocument(document)
      : normalizeText(file.content);
    updateFramed(hash, file.relativePath);
    updateFramed(hash, content);
  }
  return hash.digest('hex');
}

function updateFramed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function normalizeText(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
}
