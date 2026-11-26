export function isAbsoluteFilePath(path: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith('\\\\') ||
    path.startsWith('/')
  );
}

export function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function collapseDotSegments(inputPath: string, separator: '\\' | '/'): string {
  let prefix = '';
  let rest = inputPath;

  const driveMatch = /^([a-zA-Z]:)[\\/]*/.exec(rest);
  if (driveMatch) {
    prefix = `${driveMatch[1]}${separator}`;
    rest = rest.slice(driveMatch[0].length);
  } else if (rest.startsWith('\\\\')) {
    const uncMatch = /^\\\\([^\\/]+)[\\/]([^\\/]+)[\\/]*/.exec(rest);
    if (uncMatch) {
      prefix = `\\\\${uncMatch[1]}\\${uncMatch[2]}\\`;
      rest = rest.slice(uncMatch[0].length);
    }
  } else if (rest.startsWith('/')) {
    prefix = '/';
    rest = rest.replace(/^\/+/, '');
  }

  const stack: string[] = [];
  for (const segment of rest.split(/[\\/]+/)) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!prefix) {
        stack.push('..');
      }
      continue;
    }
    stack.push(segment);
  }

  if (!prefix) {
    return stack.join(separator);
  }
  return stack.length > 0 ? `${prefix}${stack.join(separator)}` : prefix;
}

export function replaceFilePathPrefix(
  path: string,
  oldPath: string,
  newPath: string
): string {
  const normalized = normalizeFilePath(path);
  const oldPrefix = normalizeFilePath(oldPath);
  if (normalized === oldPrefix) return newPath;
  if (!normalized.startsWith(`${oldPrefix}/`)) return path;
  return resolveFilePathFromRoot(
    normalized.slice(oldPrefix.length + 1),
    newPath
  );
}

export function resolveFilePathFromRoot(
  filePath: string,
  rootPath: string | null | undefined
): string {
  if (isAbsoluteFilePath(filePath)) {
    if (!/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(filePath)) {
      return filePath;
    }
    const separator = filePath.includes('\\') ? '\\' : '/';
    return collapseDotSegments(filePath, separator);
  }

  if (!rootPath) {
    return filePath;
  }

  const usesWindowsSeparator = rootPath.includes('\\');
  const separator = usesWindowsSeparator ? '\\' : '/';
  const base = rootPath.replace(/[\\/]+$/, '');
  const normalizedRelative = usesWindowsSeparator
    ? filePath.replaceAll('/', '\\')
    : filePath;
  const joined = `${base}${separator}${normalizedRelative}`;

  if (!/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(normalizedRelative)) {
    return joined;
  }

  return collapseDotSegments(joined, separator);
}

export function deriveRelativeFilePath(
  filePath: string,
  rootPath: string | null | undefined
): string | null {
  if (!rootPath) {
    return null;
  }

  const normalizedFilePath = normalizeFilePath(filePath);
  const normalizedRootPath = normalizeFilePath(rootPath);

  if (normalizedFilePath === normalizedRootPath) {
    return '.';
  }

  if (!normalizedFilePath.startsWith(`${normalizedRootPath}/`)) {
    return null;
  }

  return normalizedFilePath.slice(normalizedRootPath.length + 1);
}

export function findFallbackWorkspaceFilePath(params: {
  failedPath: string;
  displayPath?: string | null;
  rootPath: string | null | undefined;
  searchResults: readonly { path: string; is_file: boolean }[];
}): string | null {
  const { failedPath, displayPath, rootPath, searchResults } = params;
  if (!rootPath || searchResults.length === 0) {
    return null;
  }

  const isWindowsRoot =
    /^[a-zA-Z]:[\\/]/.test(rootPath) || rootPath.includes('\\');
  const normalizeForCompare = (value: string) => {
    const normalized = normalizeFilePath(value).replace(/^\/+/, '');
    return isWindowsRoot ? normalized.toLowerCase() : normalized;
  };

  const relativeSuffix =
    (displayPath && !isAbsoluteFilePath(displayPath) ? displayPath : null) ??
    deriveRelativeFilePath(failedPath, rootPath);
  const normalizedSuffix = relativeSuffix
    ? normalizeForCompare(relativeSuffix)
    : '';
  const targetBasename = normalizeForCompare(failedPath).split('/').pop() ?? '';
  if (!targetBasename) {
    return null;
  }

  const normalizedFailed = normalizeForCompare(failedPath);
  const fileCandidates = searchResults
    .filter((entry) => entry.is_file && entry.path.trim().length > 0)
    .map((entry) => {
      const absolute = resolveFilePathFromRoot(entry.path, rootPath);
      const comparable = normalizeForCompare(entry.path);
      return {
        absolute,
        comparable,
        comparableAbsolute: normalizeForCompare(absolute),
        basename: comparable.split('/').pop() ?? '',
      };
    })
    .filter((candidate) => candidate.comparableAbsolute !== normalizedFailed);

  if (normalizedSuffix) {
    const suffixMatches = fileCandidates.filter(
      (candidate) =>
        candidate.comparable === normalizedSuffix ||
        candidate.comparable.endsWith(`/${normalizedSuffix}`)
    );
    if (suffixMatches.length === 1) {
      return suffixMatches[0].absolute;
    }
  }

  const basenameMatches = fileCandidates.filter(
    (candidate) => candidate.basename === targetBasename
  );
  if (basenameMatches.length === 1) {
    return basenameMatches[0].absolute;
  }

  return null;
}
