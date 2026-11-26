import { describe, expect, it } from 'vitest';
import type { GitBranch } from 'shared/types';
import {
  buildBranchSegment,
  orderWorkspacesForSelector,
} from './workspaceBranchSegment';

const now = new Date('2026-10-24T00:00:00.000Z');

function branch(overrides: Partial<GitBranch>): GitBranch {
  return {
    name: 'dev',
    is_current: false,
    is_remote: false,
    is_worktree: false,
    worktree_path: null,
    last_commit_date: now,
    ...overrides,
  };
}

describe('orderWorkspacesForSelector', () => {
  it('keeps the project directory ahead of worktrees', () => {
    const ordered = orderWorkspacesForSelector([
      { id: 'wt', use_worktree: true },
      { id: 'root', use_worktree: false },
      { id: 'wt-2', use_worktree: true },
    ]);

    expect(ordered.map((workspace) => workspace.id)).toEqual([
      'root',
      'wt',
      'wt-2',
    ]);
  });

  it('keeps a single project-root workspace when duplicates exist', () => {
    const ordered = orderWorkspacesForSelector([
      { id: 'root-new', use_worktree: false },
      { id: 'wt', use_worktree: true },
      { id: 'root-old', use_worktree: false },
    ]);

    expect(ordered.map((workspace) => workspace.id)).toEqual([
      'root-new',
      'wt',
    ]);
  });

  it('keeps the preferred project-root when it is a duplicate', () => {
    const ordered = orderWorkspacesForSelector(
      [
        { id: 'root-new', use_worktree: false },
        { id: 'wt', use_worktree: true },
        { id: 'root-old', use_worktree: false },
      ],
      'root-old'
    );

    expect(ordered.map((workspace) => workspace.id)).toEqual([
      'root-old',
      'wt',
    ]);
  });
});

describe('buildBranchSegment', () => {
  it('lists local branches in the project directory with current, available, then occupied', () => {
    const entries = buildBranchSegment({
      branches: [
        branch({ name: 'feat/other' }),
        branch({ name: 'dev', is_current: true }),
        branch({
          name: 'feat/worktree',
          is_worktree: true,
          worktree_path: 'C:\\wt',
        }),
        branch({ name: 'origin/dev', is_remote: true }),
      ],
      inWorktree: false,
      currentDirectoryBranch: 'dev',
      mainDirectoryBranch: 'dev',
      mainDirectoryLabel: 'Main directory',
      occupiedByBranch: new Map([['feat/worktree', 'Worktree']]),
    });

    expect(entries).toEqual([
      { name: 'dev', role: 'current', occupiedBy: null },
      { name: 'feat/other', role: 'available', occupiedBy: null },
      { name: 'feat/worktree', role: 'occupied', occupiedBy: 'Worktree' },
    ]);
  });

  it('marks main directory and other worktree branches as occupied when inside a worktree', () => {
    const entries = buildBranchSegment({
      branches: [
        branch({ name: 'dev', is_current: true }),
        branch({
          name: 'feat/next',
          is_worktree: true,
          worktree_path: 'C:\\wt\\feat-next',
        }),
        branch({
          name: 'feat/other-wt',
          is_worktree: true,
          worktree_path: 'C:\\wt\\other',
        }),
        branch({ name: 'free/local' }),
      ],
      inWorktree: true,
      currentDirectoryBranch: 'feat/next',
      mainDirectoryBranch: 'dev',
      mainDirectoryLabel: 'Main directory',
      occupiedByBranch: new Map([
        ['dev', 'Main directory'],
        ['feat/other-wt', 'wt-other'],
      ]),
    });

    expect(entries).toEqual([
      { name: 'feat/next', role: 'current', occupiedBy: null },
      { name: 'free/local', role: 'available', occupiedBy: null },
      { name: 'dev', role: 'occupied', occupiedBy: 'Main directory' },
      { name: 'feat/other-wt', role: 'occupied', occupiedBy: 'wt-other' },
    ]);
  });
});
