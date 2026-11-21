import { stripWindowsExtendedPathPrefix } from '@/utils/displayPath';
import {
  fileExtension,
  isImageExtension,
  isVideoExtension,
  mimeForMediaExtension,
} from '@/utils/mediaAttachments';

export function hostPathFileName(path: string): string {
  const normalized = stripWindowsExtendedPathPrefix(path).replace(
    /[\\/]+$/,
    ''
  );
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function isImageHostPath(path: string): boolean {
  return isImageExtension(fileExtension(hostPathFileName(path)));
}

export function isVideoHostPath(path: string): boolean {
  return isVideoExtension(fileExtension(hostPathFileName(path)));
}

export function isAttachableMediaHostPath(path: string): boolean {
  return isImageHostPath(path) || isVideoHostPath(path);
}

export function mimeForHostPath(path: string): string {
  return mimeForMediaExtension(fileExtension(hostPathFileName(path)));
}

export function relativePathInsideRoot(
  root: string | undefined,
  absolutePath: string
): string | null {
  if (!root) return null;
  const normalizedRoot = stripWindowsExtendedPathPrefix(root)
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/');
  const normalizedPath = stripWindowsExtendedPathPrefix(absolutePath).replace(
    /\\/g,
    '/'
  );
  if (normalizedPath === normalizedRoot) return '';
  const prefix = `${normalizedRoot}/`;
  const pathMatches =
    normalizedPath.startsWith(prefix) ||
    normalizedPath.toLowerCase().startsWith(prefix.toLowerCase());
  if (!pathMatches) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

export function isPointInElement(
  element: HTMLElement,
  x: number,
  y: number
): boolean {
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export async function fileFromHostPath(
  path: string,
  readBytes: (path: string) => Promise<Uint8Array>
): Promise<File> {
  const bytes = await readBytes(path);
  const name = hostPathFileName(path) || 'dropped-file';
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new File([copy], name, { type: mimeForHostPath(path) });
}
