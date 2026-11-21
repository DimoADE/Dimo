import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type BrowserWindow,
  dialog,
  type FileFilter,
  type OpenDialogOptions,
  type SaveDialogOptions,
  shell,
} from 'electron';

export interface DesktopDialogFilter {
  name: string;
  extensions: string[];
}

export interface DesktopOpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: DesktopDialogFilter[];
}

export interface DesktopSaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DesktopDialogFilter[];
}

/**
 * Private preload -> main IPC channel used only when a trusted OS file drop
 * yields native file paths via `webUtils.getPathForFile`. Never exposed on
 * `window.dimoDesktop`.
 */
export const INTERNAL_FS_AUTHORIZE_DROPPED_PATHS_CHANNEL =
  'dimo:fs:authorizeDroppedPaths';

export const ALLOWED_EXTERNAL_SCHEMES = new Set([
  'http:',
  'https:',
  'mailto:',
  'dimo:',
  'dimo-dev:',
  'vscode:',
  'vscode-insiders:',
  'cursor:',
  'zed:',
  'windsurf:',
  'antigravity:',
]);

function normalizeForCompare(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const resolved = path.resolve(targetPath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinDirectory(
  candidate: string,
  directory: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normCandidate = normalizeForCompare(candidate, platform);
  const normDir = normalizeForCompare(directory, platform);
  if (normCandidate === normDir) {
    return true;
  }
  const sep = platform === 'win32' ? '\\' : '/';
  const dirWithSep = normDir.endsWith(sep) ? normDir : `${normDir}${sep}`;
  return normCandidate.startsWith(dirWithSep);
}

function isStrictlyWithinDirectory(
  candidate: string,
  directory: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    normalizeForCompare(candidate, platform) !==
      normalizeForCompare(directory, platform) &&
    isWithinDirectory(candidate, directory, platform)
  );
}

function isValidAbsolutePath(rawPath: string): boolean {
  return (
    typeof rawPath === 'string' &&
    rawPath.length > 0 &&
    !rawPath.includes('\0') &&
    path.isAbsolute(rawPath)
  );
}

function canonicalizeExistingPath(rawPath: string): string | null {
  const trimmed = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!isValidAbsolutePath(trimmed)) {
    return null;
  }
  try {
    return fsSync.realpathSync(trimmed);
  } catch {
    return null;
  }
}

/**
 * Canonicalizes a write destination whose leaf (or trailing subdirectories)
 * may not exist yet while still resolving existing symlinks and failing closed
 * on dangling symlinks.
 */
function canonicalizeWriteTargetPath(rawPath: string): string | null {
  const trimmed = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!isValidAbsolutePath(trimmed)) {
    return null;
  }

  let current = path.resolve(trimmed);
  const trailingSegments: string[] = [];

  while (true) {
    let lstat: fsSync.Stats | null = null;
    try {
      lstat = fsSync.lstatSync(current);
    } catch {
      lstat = null;
    }

    if (lstat !== null) {
      let canonicalExisting: string;
      try {
        canonicalExisting = fsSync.realpathSync(current);
      } catch {
        // Dangling symlink or unreadable ancestor — fail closed.
        return null;
      }
      if (trailingSegments.length === 0) {
        return canonicalExisting;
      }
      return path.join(canonicalExisting, ...trailingSegments.reverse());
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    trailingSegments.push(path.basename(current));
    current = parent;
  }
}

export interface AuthorizedLocalPathRegistryOptions {
  platform?: NodeJS.Platform;
  /**
   * Optional additional read-only allowlist (e.g. `PreviewAssetScope.isAllowed`)
   * so already-scoped preview assets remain readable when needed.
   */
  extraReadPredicate?: (canonicalPath: string) => boolean;
}

/**
 * Main-process allowlist governing local filesystem IPC reads and writes.
 *
 * Paths are only admitted through explicit user actions observed by the main
 * process or isolated preload script:
 * - `showOpenDialog` file picks -> exact file read access
 * - `showOpenDialog({ directory: true })` picks -> read + write within the chosen directory
 * - `showSaveDialog` picks -> exact file write access
 * - Trusted OS file drag-and-drop extracted by preload via `webUtils.getPathForFile` -> exact file read access
 * - `extraReadPredicate` (e.g. `PreviewAssetScope`) -> read access
 */
export class AuthorizedLocalPathRegistry {
  private readonly platform: NodeJS.Platform;
  private readonly extraReadPredicate?: (canonicalPath: string) => boolean;
  private readonly readFiles = new Set<string>();
  private readonly readDirectories = new Set<string>();
  private readonly writeFiles = new Set<string>();
  private readonly writeDirectories = new Set<string>();

  constructor(options: AuthorizedLocalPathRegistryOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.extraReadPredicate = options.extraReadPredicate;
  }

  grantReadFile(filePath: string): boolean {
    const canonical = canonicalizeExistingPath(filePath);
    if (!canonical) {
      return false;
    }
    try {
      if (!fsSync.statSync(canonical).isFile()) {
        return false;
      }
    } catch {
      return false;
    }
    this.readFiles.add(normalizeForCompare(canonical, this.platform));
    return true;
  }

  grantReadFiles(filePaths: readonly string[]): number {
    let granted = 0;
    for (const filePath of filePaths) {
      if (this.grantReadFile(filePath)) {
        granted += 1;
      }
    }
    return granted;
  }

  grantDirectory(
    dirPath: string,
    options: { writable?: boolean } = {}
  ): boolean {
    const canonical = canonicalizeExistingPath(dirPath);
    if (!canonical) {
      return false;
    }
    try {
      if (!fsSync.statSync(canonical).isDirectory()) {
        return false;
      }
    } catch {
      return false;
    }
    this.readDirectories.add(canonical);
    if (options.writable) {
      this.writeDirectories.add(canonical);
    }
    return true;
  }

  grantWriteFile(filePath: string): boolean {
    const canonical = canonicalizeWriteTargetPath(filePath);
    if (!canonical) {
      return false;
    }
    this.writeFiles.add(normalizeForCompare(canonical, this.platform));
    return true;
  }

  resolveAuthorizedReadPath(filePath: string): string | null {
    const canonical = canonicalizeExistingPath(filePath);
    if (!canonical) {
      return null;
    }
    if (this.extraReadPredicate?.(canonical)) {
      return canonical;
    }
    const normalized = normalizeForCompare(canonical, this.platform);
    if (this.readFiles.has(normalized)) {
      return canonical;
    }
    for (const dir of this.readDirectories) {
      if (isStrictlyWithinDirectory(canonical, dir, this.platform)) {
        return canonical;
      }
    }
    return null;
  }

  canRead(filePath: string): boolean {
    return this.resolveAuthorizedReadPath(filePath) !== null;
  }

  resolveAuthorizedWritePath(filePath: string): string | null {
    const canonical = canonicalizeWriteTargetPath(filePath);
    if (!canonical) {
      return null;
    }
    const normalized = normalizeForCompare(canonical, this.platform);
    if (this.writeFiles.has(normalized)) {
      return canonical;
    }
    for (const dir of this.writeDirectories) {
      if (isStrictlyWithinDirectory(canonical, dir, this.platform)) {
        return canonical;
      }
    }
    return null;
  }

  canWrite(filePath: string): boolean {
    return this.resolveAuthorizedWritePath(filePath) !== null;
  }

  assertCanRead(filePath: string): string {
    const authorized = this.resolveAuthorizedReadPath(filePath);
    if (!authorized) {
      throw new Error(`Refused unauthorized local file read: ${filePath}`);
    }
    return authorized;
  }

  assertCanWrite(filePath: string): string {
    const authorized = this.resolveAuthorizedWritePath(filePath);
    if (!authorized) {
      throw new Error(`Refused unauthorized local file write: ${filePath}`);
    }
    return authorized;
  }
}

function normalizeFilters(
  filters?: DesktopDialogFilter[]
): FileFilter[] | undefined {
  if (!Array.isArray(filters) || filters.length === 0) {
    return undefined;
  }
  return filters.map((filter) => ({
    name: filter.name,
    extensions: filter.extensions.map((ext) => ext.replace(/^\./, '')),
  }));
}

export async function showOpenDialog(
  parent: BrowserWindow | undefined,
  options?: DesktopOpenDialogOptions,
  authorizedPaths?: AuthorizedLocalPathRegistry
): Promise<string | string[] | null> {
  const properties: NonNullable<OpenDialogOptions['properties']> = [];
  if (options?.directory) {
    properties.push('openDirectory', 'createDirectory');
  } else {
    properties.push('openFile');
  }
  if (options?.multiple) {
    properties.push('multiSelections');
  }

  const dialogOptions: OpenDialogOptions = {
    properties,
    ...(options?.title ? { title: options.title } : {}),
    ...(options?.defaultPath ? { defaultPath: options.defaultPath } : {}),
    ...(options?.filters
      ? { filters: normalizeFilters(options.filters) }
      : {}),
  };

  const result = parent
    ? await dialog.showOpenDialog(parent, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  if (authorizedPaths) {
    for (const selectedPath of result.filePaths) {
      if (options?.directory) {
        // Directory picks are used both for read workflows and multi-file export
        // packs (e.g. `exportProjectConversationPack`), so grant read+write within
        // the user-selected directory.
        authorizedPaths.grantDirectory(selectedPath, { writable: true });
      } else {
        authorizedPaths.grantReadFile(selectedPath);
      }
    }
  }

  return options?.multiple ? result.filePaths : result.filePaths[0];
}

export async function showSaveDialog(
  parent: BrowserWindow | undefined,
  options?: DesktopSaveDialogOptions,
  authorizedPaths?: AuthorizedLocalPathRegistry
): Promise<string | null> {
  const dialogOptions: SaveDialogOptions = {
    ...(options?.title ? { title: options.title } : {}),
    ...(options?.defaultPath ? { defaultPath: options.defaultPath } : {}),
    ...(options?.filters
      ? { filters: normalizeFilters(options.filters) }
      : {}),
  };

  const result = parent
    ? await dialog.showSaveDialog(parent, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);

  if (result.canceled || !result.filePath) {
    return null;
  }
  authorizedPaths?.grantWriteFile(result.filePath);
  return result.filePath;
}

export async function readLocalFile(
  filePath: string,
  authorizedPaths: AuthorizedLocalPathRegistry
): Promise<Uint8Array> {
  const canonical = authorizedPaths.assertCanRead(filePath);
  const buffer = await fs.readFile(canonical);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export async function writeLocalFile(
  filePath: string,
  contents: Uint8Array,
  authorizedPaths: AuthorizedLocalPathRegistry
): Promise<void> {
  const canonical = authorizedPaths.assertCanWrite(filePath);
  await fs.mkdir(path.dirname(canonical), { recursive: true });
  await fs.writeFile(canonical, Buffer.from(contents));
}

export async function writeLocalTextFile(
  filePath: string,
  contents: string,
  authorizedPaths: AuthorizedLocalPathRegistry
): Promise<void> {
  const canonical = authorizedPaths.assertCanWrite(filePath);
  await fs.mkdir(path.dirname(canonical), { recursive: true });
  await fs.writeFile(canonical, contents, 'utf8');
}

export function joinLocalPath(...parts: string[]): string {
  return path.join(...parts);
}

export async function openExternalTarget(target: string): Promise<void> {
  const trimmed = target.trim();
  if (!trimmed) {
    return;
  }

  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }

  if (parsed && ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
    await shell.openExternal(trimmed);
    return;
  }

  // Allow opening local filesystem paths when an absolute path is explicitly passed.
  if (path.isAbsolute(trimmed)) {
    const errorMessage = await shell.openPath(trimmed);
    if (errorMessage) {
      throw new Error(`Failed to open path: ${errorMessage}`);
    }
    return;
  }

  throw new Error(`Refused to open unsupported external target: ${trimmed}`);
}

export async function revealInFileManager(targetPath: string): Promise<void> {
  const trimmed = targetPath.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`Path must be absolute: ${targetPath}`);
  }
  const stat = await fs.stat(trimmed);
  if (stat.isDirectory()) {
    const errorMessage = await shell.openPath(trimmed);
    if (errorMessage) {
      throw new Error(`Failed to open directory in file manager: ${errorMessage}`);
    }
    return;
  }
  shell.showItemInFolder(trimmed);
}
