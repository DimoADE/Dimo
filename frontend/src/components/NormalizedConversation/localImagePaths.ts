import { resolveFilePathFromRoot } from '@/utils/filePaths';
import {
  isAbsoluteLocalPath,
  trimFilePathCandidate,
} from './MarkdownResourceLink';

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripFileUrlPrefix(value: string): string {
  const withoutScheme = value.replace(/^file:\/\/(?:localhost)?/i, '');
  // On Windows, `file:///E:/path/img.png` leaves a leading slash before the drive letter.
  return withoutScheme.replace(/^\/+([a-zA-Z]:[\\/])/, '$1');
}

/** Remote / inline / blob images render as-is (no local file resolution). */
export function isRenderableRemoteImage(src: string): boolean {
  return (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:image/') ||
    src.startsWith('blob:')
  );
}

export function isMarkdownImagePath(value: string): boolean {
  const candidate = trimFilePathCandidate(value);
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#].*)?$/i.test(candidate);
}

/**
 * Resolve an image destination from markdown to an absolute local path.
 *
 * `workspacePath` is the base directory relative markdown paths are resolved
 * against (the containing directory of a markdown file, or a task workspace
 * root in conversation rendering).
 */
export function resolveLocalMarkdownImagePath(
  src: string,
  workspacePath?: string | null
): string | null {
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith('#') || isRenderableRemoteImage(trimmed)) {
    return null;
  }

  const withoutQueryOrHash = trimmed.replace(/[?#].*$/, '');
  if (!withoutQueryOrHash) return null;

  if (/^file:\/\//i.test(withoutQueryOrHash)) {
    const decoded = safeDecodeUriComponent(
      stripFileUrlPrefix(withoutQueryOrHash)
    );
    return decoded ? resolveFilePathFromRoot(decoded, null) : null;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(withoutQueryOrHash)) {
    return null;
  }

  const decoded = safeDecodeUriComponent(withoutQueryOrHash);
  if (isAbsoluteLocalPath(decoded)) {
    return resolveFilePathFromRoot(decoded, null);
  }
  if (!workspacePath) {
    return null;
  }

  return resolveFilePathFromRoot(decoded, workspacePath);
}
