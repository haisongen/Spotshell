import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { SPACE_V1_LIMITS } from './limits.js';

const supportedTextExtensions = new Set([
  '.bash', '.c', '.conf', '.config', '.cpp', '.cs', '.css', '.env', '.go', '.h',
  '.hpp', '.html', '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.log', '.md',
  '.mjs', '.php', '.properties', '.ps1', '.py', '.rb', '.rs', '.sh', '.sql', '.toml',
  '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml', '.zsh',
]);
const supportedExtensionlessNames = new Set(['Dockerfile', 'Makefile']);

export interface ManagedTextFile {
  relativePath: string;
  content: string;
  sizeBytes: number;
}

export class ObjectRootError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ObjectRootError';
  }
}

export class SafeObjectRoot {
  private constructor(
    readonly rootPath: string,
    private readonly realRootPath: string
  ) {}

  static async open(rootPath: string): Promise<SafeObjectRoot> {
    const absoluteRoot = path.resolve(rootPath);
    const stats = await fs.lstat(absoluteRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ObjectRootError('Knowledge object root must be a real directory, not a link');
    }
    const realRoot = await fs.realpath(absoluteRoot);
    return new SafeObjectRoot(absoluteRoot, realRoot);
  }

  async listTextFiles(): Promise<ManagedTextFile[]> {
    const files: ManagedTextFile[] = [];
    const counters = { directories: 0, bytes: 0 };
    await this.walk('', 0, files, counters);
    return files.sort((left, right) => compareRelativePaths(
      left.relativePath,
      right.relativePath
    ));
  }

  async readText(relativePath: string): Promise<ManagedTextFile> {
    const normalizedPath = normalizeRelativePath(relativePath);
    assertSupportedTextPath(normalizedPath);
    const absolutePath = path.join(this.rootPath, ...normalizedPath.split('/'));
    const bytes = await this.readValidatedFile(absolutePath, normalizedPath);
    return {
      relativePath: normalizedPath,
      content: decodeManagedText(bytes, normalizedPath),
      sizeBytes: bytes.byteLength,
    };
  }

  private async walk(
    relativeDirectory: string,
    depth: number,
    files: ManagedTextFile[],
    counters: { directories: number; bytes: number }
  ): Promise<void> {
    if (depth > SPACE_V1_LIMITS.maxDirectoryDepth) {
      throw new ObjectRootError(
        `Directory depth exceeds ${SPACE_V1_LIMITS.maxDirectoryDepth}: ${relativeDirectory}`
      );
    }
    const absoluteDirectory = relativeDirectory
      ? path.join(this.rootPath, ...relativeDirectory.split('/'))
      : this.rootPath;
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stats = await fs.lstat(absolutePath);
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw new ObjectRootError(`Links and reparse points are not allowed: ${relativePath}`);
      }
      const realPath = await fs.realpath(absolutePath);
      if (!isInsideRoot(this.realRootPath, realPath)) {
        throw new ObjectRootError(`Path escapes the knowledge object root: ${relativePath}`);
      }
      if (stats.isDirectory()) {
        counters.directories += 1;
        if (counters.directories > SPACE_V1_LIMITS.maxDirectoriesPerObject) {
          throw new ObjectRootError(
            `Object exceeds ${SPACE_V1_LIMITS.maxDirectoriesPerObject} directories`
          );
        }
        await this.walk(relativePath, depth + 1, files, counters);
        continue;
      }
      if (!stats.isFile()) {
        throw new ObjectRootError(`Unsupported filesystem entry: ${relativePath}`);
      }
      if (files.length >= SPACE_V1_LIMITS.maxFilesPerObject) {
        throw new ObjectRootError(`Object exceeds ${SPACE_V1_LIMITS.maxFilesPerObject} files`);
      }
      assertSupportedTextPath(relativePath);
      if (stats.size > SPACE_V1_LIMITS.maxFileBytes) {
        throw new ObjectRootError(`File exceeds ${SPACE_V1_LIMITS.maxFileBytes} bytes: ${relativePath}`);
      }
      const bytes = await this.readValidatedFile(absolutePath, relativePath);
      counters.bytes += bytes.byteLength;
      if (counters.bytes > SPACE_V1_LIMITS.maxObjectBytes) {
        throw new ObjectRootError(`Object exceeds ${SPACE_V1_LIMITS.maxObjectBytes} bytes`);
      }
      files.push({
        relativePath: normalizeRelativePath(relativePath),
        content: decodeManagedText(bytes, relativePath),
        sizeBytes: bytes.byteLength,
      });
    }
  }

  private async readValidatedFile(
    absolutePath: string,
    relativePath: string
  ): Promise<Uint8Array> {
    await this.assertSafeTarget(absolutePath, relativePath);
    const handle = await fs.open(absolutePath, 'r');
    try {
      const openedStats = await handle.stat({ bigint: true });
      if (!openedStats.isFile()) {
        throw new ObjectRootError(`Managed path is not a regular file: ${relativePath}`);
      }
      if (openedStats.size > BigInt(SPACE_V1_LIMITS.maxFileBytes)) {
        throw new ObjectRootError(
          `File exceeds ${SPACE_V1_LIMITS.maxFileBytes} bytes: ${relativePath}`
        );
      }

      await this.assertSafeTarget(absolutePath, relativePath);
      const currentStats = await fs.stat(absolutePath, { bigint: true });
      const sameFile = openedStats.ino === currentStats.ino && (
        process.platform === 'win32' || openedStats.dev === currentStats.dev
      );
      if (!sameFile) {
        throw new ObjectRootError(`Managed file changed during validation: ${relativePath}`);
      }
      return await readCappedFile(handle, relativePath);
    } finally {
      await handle.close();
    }
  }

  private async assertSafeTarget(absolutePath: string, relativePath: string): Promise<void> {
    let currentPath = this.rootPath;
    for (const segment of relativePath.split('/')) {
      currentPath = path.join(currentPath, segment);
      const stats = await fs.lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new ObjectRootError(`Links and reparse points are not allowed: ${relativePath}`);
      }
    }
    const realPath = await fs.realpath(absolutePath);
    if (!isInsideRoot(this.realRootPath, realPath)) {
      throw new ObjectRootError(`Path escapes the knowledge object root: ${relativePath}`);
    }
  }
}

export function normalizeRelativePath(relativePath: string): string {
  if (!relativePath || relativePath.includes('\0')) {
    throw new ObjectRootError('Object file path must not be empty');
  }
  if (
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new ObjectRootError(`Absolute object file paths are not allowed: ${relativePath}`);
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ObjectRootError(`Object file path traversal is not allowed: ${relativePath}`);
  }
  if (normalized.length > SPACE_V1_LIMITS.maxRelativePathChars) {
    throw new ObjectRootError(
      `Object file path exceeds ${SPACE_V1_LIMITS.maxRelativePathChars} characters`
    );
  }
  return normalized;
}

/** Normalize and reject unsupported managed text paths (including PDF and binaries by extension). */
export function assertManagedTextPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  assertSupportedTextPath(normalized);
  return normalized;
}

/** True when a path may be registered as guidance (Markdown/text only, never SPACE.md). */
export function isGuidanceEligiblePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === 'SPACE.md') return false;
  const extension = path.posix.extname(normalized).toLocaleLowerCase('en-US');
  return extension === '.md' || extension === '.txt';
}

/**
 * Decode UTF-8 managed text, rejecting invalid encoding and embedded nulls.
 * Exposed for import paths that already hold raw bytes.
 */
export function decodeManagedTextBytes(bytes: Uint8Array, relativePath: string): string {
  return decodeManagedText(bytes, relativePath);
}

async function readCappedFile(
  handle: FileHandle,
  relativePath: string
): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(SPACE_V1_LIMITS.maxFileBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      bytesRead,
      buffer.byteLength - bytesRead,
      bytesRead
    );
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  if (bytesRead > SPACE_V1_LIMITS.maxFileBytes) {
    throw new ObjectRootError(
      `File exceeds ${SPACE_V1_LIMITS.maxFileBytes} bytes: ${relativePath}`
    );
  }
  return buffer.subarray(0, bytesRead);
}

function assertSupportedTextPath(relativePath: string): void {
  if (relativePath.toLocaleLowerCase('en-US').endsWith('.pdf')) {
    throw new ObjectRootError(`PDF files are not supported in schema v1: ${relativePath}`);
  }
  const extension = path.posix.extname(relativePath).toLocaleLowerCase('en-US');
  const basename = path.posix.basename(relativePath);
  if (!supportedTextExtensions.has(extension) && !supportedExtensionlessNames.has(basename)) {
    throw new ObjectRootError(`Unsupported text file type: ${relativePath}`);
  }
}

function decodeManagedText(bytes: Uint8Array, relativePath: string): string {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ObjectRootError(`File is not valid UTF-8: ${relativePath}`, { cause: error });
  }
  if (content.includes('\0')) {
    throw new ObjectRootError(`Binary content is not supported: ${relativePath}`);
  }
  return content;
}

function isInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function compareRelativePaths(left: string, right: string): number {
  return left.toLocaleLowerCase('en-US').localeCompare(
    right.toLocaleLowerCase('en-US'),
    'en-US'
  ) || left.localeCompare(right, 'en-US');
}
