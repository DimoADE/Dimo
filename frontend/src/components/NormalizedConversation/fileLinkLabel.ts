import type { FileOpenLocation } from '@/components/file-tree/file-tree-types';

const HASH_LINE_RANGE_RE = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?$/i;
const COLON_LINE_RANGE_RE = /:(\d+)(?:-(\d+)|:(\d+))?$/;

export function extractFileLocation(value: string): FileOpenLocation | null {
  const cleaned = value
    .trim()
    .replace(/^['"`]+/, '')
    .replace(/['"`.,;]+$/, '')
    .replace(/[)\]}]+$/, '');
  if (!cleaned) return null;

  const hashMatch = cleaned.match(HASH_LINE_RANGE_RE);
  if (hashMatch) {
    const line = Number(hashMatch[1]);
    if (!Number.isFinite(line) || line < 1) return null;
    const column = hashMatch[2] ? Math.max(1, Number(hashMatch[2])) : 1;
    const rawEnd = hashMatch[3] ? Number(hashMatch[3]) : undefined;
    const endLine =
      rawEnd && Number.isFinite(rawEnd) && rawEnd > line ? rawEnd : undefined;
    return endLine ? { line, column, endLine } : { line, column };
  }

  // Avoid treating Windows drive letters like `C:` as line numbers.
  const withoutDrive = cleaned.replace(/^[a-zA-Z]:/, '');
  const colonMatch = withoutDrive.match(COLON_LINE_RANGE_RE);
  if (colonMatch) {
    const line = Number(colonMatch[1]);
    if (!Number.isFinite(line) || line < 1) return null;
    const rawEnd = colonMatch[2] ? Number(colonMatch[2]) : undefined;
    const rawCol = colonMatch[3] ? Number(colonMatch[3]) : undefined;
    const column = rawCol && Number.isFinite(rawCol) ? Math.max(1, rawCol) : 1;
    const endLine =
      rawEnd && Number.isFinite(rawEnd) && rawEnd > line ? rawEnd : undefined;
    return endLine ? { line, column, endLine } : { line, column };
  }

  return null;
}

export function formatLineLocationSuffix(
  location: FileOpenLocation | null | undefined
): string | null {
  if (!location || !Number.isFinite(location.line) || location.line < 1) {
    return null;
  }
  if (location.endLine && location.endLine > location.line) {
    return `L${location.line}\u2013${location.endLine}`;
  }
  return `L${location.line}`;
}

function splitPathSegments(filePath: string): string[] {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
}

/**
 * Given all display file paths referenced in a single message, returns a map
 * from normalized displayPath to the minimal parent directory suffix needed to
 * disambiguate duplicate basenames (e.g. `src/turn` when two `mod.rs` exist).
 */
export function buildBasenameDisambiguationMap(
  displayPaths: Iterable<string>
): Map<string, string> {
  const uniquePaths = new Set<string>();
  for (const raw of displayPaths) {
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized) uniquePaths.add(normalized);
  }

  const byBasename = new Map<string, string[]>();
  for (const path of uniquePaths) {
    const segments = splitPathSegments(path);
    const base = segments[segments.length - 1];
    if (!base) continue;
    const list = byBasename.get(base) ?? [];
    list.push(path);
    byBasename.set(base, list);
  }

  const disambiguation = new Map<string, string>();
  for (const paths of byBasename.values()) {
    if (paths.length <= 1) continue;
    const segmented = paths.map((path) => ({
      path,
      parents: splitPathSegments(path).slice(0, -1),
    }));

    for (const entry of segmented) {
      if (entry.parents.length === 0) continue;
      let suffix = '';
      for (let depth = 1; depth <= entry.parents.length; depth += 1) {
        const candidate = entry.parents.slice(-depth).join('/');
        const collision = segmented.some(
          (other) =>
            other.path !== entry.path &&
            other.parents.slice(-depth).join('/') === candidate
        );
        suffix = candidate;
        if (!collision) break;
      }
      if (suffix) {
        disambiguation.set(entry.path, suffix);
      }
    }
  }

  return disambiguation;
}

/**
 * Formats a concise file link label like T3Code:
 * `restart_continuation.rs · src/turn · L22`
 */
export function formatCompactFileLinkLabel(options: {
  displayPath: string;
  nodeType: 'file' | 'folder';
  location?: FileOpenLocation | null;
  disambiguationSuffix?: string | null;
}): string {
  const normalized = options.displayPath
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const segments = splitPathSegments(normalized);
  if (segments.length === 0) return options.displayPath;

  const base =
    options.nodeType === 'folder'
      ? segments.slice(-2).join('/')
      : (segments[segments.length - 1] ?? normalized);

  const parts: string[] = [base];
  if (options.nodeType === 'file' && options.disambiguationSuffix) {
    parts.push(options.disambiguationSuffix);
  }
  const lineSuffix = formatLineLocationSuffix(options.location);
  if (lineSuffix) {
    parts.push(lineSuffix);
  }
  return parts.join(' \u00b7 ');
}
