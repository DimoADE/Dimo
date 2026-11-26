import type { GitBranch } from 'shared/types';

export type BranchSegmentRole = 'current' | 'available' | 'occupied';

export interface BranchSegmentEntry {
  name: string;
  role: BranchSegmentRole;
  /** Directory or worktree label holding this branch when role === 'occupied'. */
  occupiedBy: string | null;
}

function normalizeBranch(branch: string | null | undefined): string {
  return branch?.trim().toLowerCase() ?? '';
}

function sameBranch(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const normalizedLeft = normalizeBranch(left);
  const normalizedRight = normalizeBranch(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

export function orderWorkspacesForSelector<
  T extends { id: string; use_worktree: boolean },
>(workspaces: readonly T[], preferredId?: string | null): T[] {
  const roots: T[] = [];
  const worktrees: T[] = [];
  for (const workspace of workspaces) {
    if (workspace.use_worktree) {
      worktrees.push(workspace);
    } else {
      roots.push(workspace);
    }
  }
  const preferredRoot = preferredId
    ? roots.find((workspace) => workspace.id === preferredId)
    : undefined;
  const root = preferredRoot ?? roots[0];
  return root ? [root, ...worktrees] : [...worktrees];
}

const ROLE_ORDER: Record<BranchSegmentRole, number> = {
  current: 0,
  available: 1,
  occupied: 2,
};

/**
 * Local branches for the current directory's branch switcher.
 * Branches checked out in another directory (main repo or another worktree)
 * are kept visible as disabled `'occupied'` entries so git's single-checkout
 * constraint is explicit without silently jumping across worktrees.
 */
export function buildBranchSegment({
  branches,
  inWorktree,
  currentDirectoryBranch,
  mainDirectoryBranch,
  mainDirectoryLabel = null,
  occupiedByBranch,
}: {
  branches: readonly GitBranch[];
  inWorktree: boolean;
  currentDirectoryBranch: string | null;
  mainDirectoryBranch: string | null;
  mainDirectoryLabel?: string | null;
  occupiedByBranch?: ReadonlyMap<string, string>;
}): BranchSegmentEntry[] {
  const localBranches = branches.filter((branch) => !branch.is_remote);
  const mainName =
    localBranches.find((branch) => branch.is_current)?.name ??
    mainDirectoryBranch;
  const currentName = inWorktree
    ? currentDirectoryBranch
    : (currentDirectoryBranch ?? mainName);

  const entries: BranchSegmentEntry[] = [];
  const seen = new Set<string>();

  for (const branch of localBranches) {
    const key = normalizeBranch(branch.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (sameBranch(branch.name, currentName)) {
      entries.push({
        name: branch.name,
        role: 'current',
        occupiedBy: null,
      });
      continue;
    }

    if (
      inWorktree &&
      (branch.is_current || sameBranch(branch.name, mainName))
    ) {
      entries.push({
        name: branch.name,
        role: 'occupied',
        occupiedBy: mainDirectoryLabel ?? occupiedByBranch?.get(key) ?? null,
      });
      continue;
    }

    if (branch.is_worktree || occupiedByBranch?.has(key)) {
      entries.push({
        name: branch.name,
        role: 'occupied',
        occupiedBy: occupiedByBranch?.get(key) ?? null,
      });
      continue;
    }

    entries.push({
      name: branch.name,
      role: 'available',
      occupiedBy: null,
    });
  }

  const normalizedCurrent = normalizeBranch(currentName);
  if (currentName && normalizedCurrent && !seen.has(normalizedCurrent)) {
    entries.unshift({
      name: currentName,
      role: 'current',
      occupiedBy: null,
    });
  }

  return entries.sort((left, right) => {
    return ROLE_ORDER[left.role] - ROLE_ORDER[right.role];
  });
}
