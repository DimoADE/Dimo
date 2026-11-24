function compareRailSiblings<
  T extends { id: string; name: string; is_home?: boolean },
>(left: T, right: T): number {
  if (Boolean(left.is_home) !== Boolean(right.is_home)) {
    return left.is_home ? -1 : 1;
  }
  const byName = left.name.localeCompare(right.name, undefined, {
    sensitivity: 'base',
  });
  if (byName !== 0) {
    return byName;
  }
  return left.id.localeCompare(right.id);
}

export function buildProjectRailTree<
  T extends {
    id: string;
    name: string;
    parent_project_id?: string | null;
    is_home?: boolean;
  },
>(projects: T[]): Array<T & { depth: number }> {
  const byParent = new Map<string | null, T[]>();
  for (const project of projects) {
    const parent = project.is_home ? null : (project.parent_project_id ?? null);
    const list = byParent.get(parent) ?? [];
    list.push(project);
    byParent.set(parent, list);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(compareRailSiblings);
  }

  const nested: Array<T & { depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const project of byParent.get(parentId) ?? []) {
      nested.push({ ...project, depth });
      walk(project.id, depth + 1);
    }
  };
  walk(null, 0);

  const seen = new Set(nested.map((project) => project.id));
  for (const project of projects) {
    if (!seen.has(project.id)) {
      nested.push({ ...project, depth: 0 });
    }
  }
  return nested;
}

export function formatCompactProjectPath(rawPath?: string | null): string {
  const normalized = (rawPath ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!normalized) {
    return '';
  }

  const homeNormalized = normalized
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\/Users\/[^/]+/i, '~');

  const segments = homeNormalized.split('/').filter(Boolean);
  if (segments.length <= 3) {
    return homeNormalized;
  }

  const prefix = homeNormalized.startsWith('~')
    ? '~'
    : homeNormalized.startsWith('/')
      ? ''
      : segments[0];
  const tail = segments.slice(-2).join('/');
  return prefix ? `${prefix}/.../${tail}` : `/.../${tail}`;
}

export function filterProjectsByQuery<
  T extends {
    id: string;
    displayName: string;
    root_path?: string | null;
  },
>(items: T[], rawQuery: string): T[] {
  const query = rawQuery.trim().toLowerCase().replace(/\\/g, '/');
  if (!query) {
    return items;
  }

  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const nameLower = item.displayName.toLowerCase();
    const pathLower = (item.root_path ?? '').toLowerCase().replace(/\\/g, '/');
    if (nameLower === query) {
      scored.push({ item, score: 0 });
    } else if (nameLower.startsWith(query)) {
      scored.push({ item, score: 1 });
    } else if (nameLower.includes(query)) {
      scored.push({ item, score: 2 });
    } else if (pathLower.includes(query)) {
      scored.push({ item, score: 3 });
    }
  }

  scored.sort((left, right) => left.score - right.score);
  return scored.map((entry) => entry.item);
}

export function pickDefaultProjectTarget<
  T extends {
    id: string;
    is_home?: boolean;
  },
>(input: {
  projects: T[];
  projectsById: Record<string, T | undefined>;
  openProjectIds: string[];
  excludeProjectId?: string | null;
}): string | null {
  const excluded = input.excludeProjectId ?? null;
  const fromOpen = input.openProjectIds.find(
    (projectId) =>
      projectId !== excluded && Boolean(input.projectsById[projectId])
  );
  if (fromOpen) {
    return fromOpen;
  }

  const firstImported = input.projects.find(
    (project) => project.id !== excluded && !project.is_home
  );
  return firstImported?.id ?? null;
}
