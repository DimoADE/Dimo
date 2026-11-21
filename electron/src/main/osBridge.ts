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

const ALLOWED_EXTERNAL_SCHEMES = new Set([
  'http:',
  'https:',
  'mailto:',
  'dimo:',
  'dimo-dev:',
  'vscode:',
  'cursor:',
  'zed:',
  'windsurf:',
]);

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
  options?: DesktopOpenDialogOptions
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
  return options?.multiple ? result.filePaths : result.filePaths[0];
}

export async function showSaveDialog(
  parent: BrowserWindow | undefined,
  options?: DesktopSaveDialogOptions
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
  return result.filePath;
}

export async function readLocalFile(filePath: string): Promise<Uint8Array> {
  const buffer = await fs.readFile(filePath);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export async function writeLocalFile(
  filePath: string,
  contents: Uint8Array
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(contents));
}

export async function writeLocalTextFile(
  filePath: string,
  contents: string
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
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
