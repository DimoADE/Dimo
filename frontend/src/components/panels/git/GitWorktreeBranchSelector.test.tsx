import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GitBranch, GitWorktreeInfo, Workspace } from 'shared/types';
import {
  GitWorktreeBranchSelector,
  buildDirectoryBranchGroups,
  type GitDiffTarget,
} from './GitWorktreeBranchSelector';
import {
  GitLogBranchFilter,
  resolveDefaultLogBranches,
} from './GitLogBranchFilter';

function makeBranch(
  name: string,
  overrides: Partial<GitBranch> = {}
): GitBranch {
  return {
    name,
    is_current: false,
    is_remote: false,
    is_worktree: false,
    worktree_path: null,
    last_commit_date: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    project_id: 'proj-1',
    name: 'feat-payments',
    branch: 'feat/payments',
    container_ref: '/repo/.worktrees/feat-payments',
    archived: false,
    pinned: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    use_worktree: true,
    ...overrides,
  } as Workspace;
}

describe('buildDirectoryBranchGroups & GitWorktreeBranchSelector', () => {
  it('omits Level 2 (collapsed=true) when a directory only has a single branch', () => {
    const worktrees: GitWorktreeInfo[] = [
      {
        path: '/repo',
        branch: 'main',
        head_sha: 'aaa1111',
        is_main: true,
        is_detached: false,
        is_bare: false,
      },
      {
        path: '/repo/.worktrees/feat-payments',
        branch: 'feat/payments',
        head_sha: 'bbb2222',
        is_main: false,
        is_detached: false,
        is_bare: false,
      },
    ];
    const branches: GitBranch[] = [
      makeBranch('main', { is_current: true }),
      makeBranch('feat/payments', { is_worktree: true }),
      makeBranch('origin/main', { is_remote: true }),
    ];

    const groups = buildDirectoryBranchGroups({
      worktrees,
      branches,
      workspaces: [makeWorkspace()],
      fallbackCurrentBranch: 'main',
      baseBranch: 'main',
      defaultDirLabel: 'Default Directory',
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].collapsed).toBe(true);
    expect(groups[0].options).toHaveLength(1);
    expect(groups[1].collapsed).toBe(true);
    expect(groups[1].options).toHaveLength(1);
    expect(groups[1].options[0]).toMatchObject({
      kind: 'worktree',
      workspaceId: 'ws-1',
      isExternal: false,
    });
  });

  it('expands Level 2 under Default Directory for non-checked-out local branches and marks external worktrees', () => {
    const worktrees: GitWorktreeInfo[] = [
      {
        path: '/repo',
        branch: 'main',
        head_sha: 'aaa1111',
        is_main: true,
        is_detached: false,
        is_bare: false,
      },
      {
        path: '/tmp/external-hotfix',
        branch: 'hotfix/auth',
        head_sha: 'ccc3333',
        is_main: false,
        is_detached: false,
        is_bare: false,
      },
    ];
    const branches: GitBranch[] = [
      makeBranch('main', { is_current: true }),
      makeBranch('feat/search'),
      makeBranch('hotfix/auth', { is_worktree: true }),
    ];

    const groups = buildDirectoryBranchGroups({
      worktrees,
      branches,
      workspaces: [],
      fallbackCurrentBranch: 'main',
      baseBranch: 'main',
      defaultDirLabel: 'Default Directory',
    });

    // Main dir has live main + read-only feat/search => 2-level group (collapsed=false)
    expect(groups[0].collapsed).toBe(false);
    expect(groups[0].options).toHaveLength(2);
    expect(groups[0].options[1]).toMatchObject({
      kind: 'branch',
      branch: 'feat/search',
      baseBranch: 'main',
    });

    // External worktree has 1 branch => collapsed single row with isExternal=true
    expect(groups[1].collapsed).toBe(true);
    expect(groups[1].isExternal).toBe(true);
    expect(groups[1].directoryLabel).toBe('external-hotfix');

    const onSelectTarget = vi.fn();
    render(
      <GitWorktreeBranchSelector
        groups={groups}
        selectedTarget={groups[0].options[0]}
        onSelectTarget={onSelectTarget}
      />
    );

    const selectorRoot = screen.getByTestId('git-worktree-branch-selector');
    expect(selectorRoot.className).toContain('astryx-selector');
    expect(selectorRoot.className).toContain('git-branch-selector');
    fireEvent.click(selectorRoot);

    // Level 1 shows directories without dumping branches directly beneath Default Directory
    expect(
      screen.queryByRole('group', { name: 'Default Directory' })
    ).toBeNull();
    expect(screen.queryByText('feat/search')).toBeNull();

    // Linked worktree row displays "Worktree" rather than "External" / "外部"
    const worktreeOption = screen.getByRole('option', {
      name: /hotfix\/auth/,
    });
    expect(worktreeOption.textContent).toContain('Worktree');
    expect(worktreeOption.textContent).not.toContain('外部');
    expect(worktreeOption.textContent).not.toContain('External');

    // Clicking Default Directory opens Level 2 branch list
    fireEvent.click(screen.getByTestId('git-dir-group-dir:main'));
    const mainGroup = screen.getByRole('group', { name: 'Default Directory' });
    expect(within(mainGroup).getByText('main')).toBeTruthy();

    // Read-only branch displays concise "只读" badge instead of "只读差异"
    const branchOption = within(mainGroup).getByRole('option', {
      name: /feat\/search/,
    });
    expect(branchOption.textContent).toContain('只读');
    expect(branchOption.textContent).not.toContain('只读差异');

    // Back button returns cleanly to Level 1 directory list
    fireEvent.click(screen.getByTestId('git-branch-selector-back'));
    expect(
      screen.queryByRole('group', { name: 'Default Directory' })
    ).toBeNull();

    // Re-enter Level 2 and select read-only branch target without checkout
    fireEvent.click(screen.getByTestId('git-dir-group-dir:main'));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Default Directory' })
      ).getByRole('option', {
        name: /feat\/search/,
      })
    );
    expect(onSelectTarget).toHaveBeenCalledTimes(1);
    expect(onSelectTarget.mock.calls[0][0]).toMatchObject<
      Partial<GitDiffTarget>
    >({
      kind: 'branch',
      branch: 'feat/search',
      baseBranch: 'main',
    });
  });

  it('renders a cursor-safe 11px search input and filters long branch names cleanly when more than 6 targets exist', () => {
    const worktrees: GitWorktreeInfo[] = [
      {
        path: '/repo',
        branch: 'master',
        head_sha: 'aaa1111',
        is_main: true,
        is_detached: false,
        is_bare: false,
      },
    ];
    const branches: GitBranch[] = [
      makeBranch('master', { is_current: true }),
      makeBranch('refactor/native-engine-architecture'),
      makeBranch('canvas-audit-fixes'),
      makeBranch('feat/cross-agent-foundation'),
      makeBranch('integration/t3code-refactor'),
      makeBranch(
        'member/115d0a52-5063-55a2-a17d-f15b7fd6a0b3/2e8266c3-658f-5fe7-9553-05283d9e95c6'
      ),
      makeBranch(
        'member/44421762-bc3a-542d-950e-cfe0d56ccf9f/58b7092b-ab19-5116-90c2-2df907f5e85f'
      ),
    ];

    const groups = buildDirectoryBranchGroups({
      worktrees,
      branches,
      workspaces: [],
      fallbackCurrentBranch: 'master',
      baseBranch: 'master',
      defaultDirLabel: '默认目录',
    });

    const onSelectTarget = vi.fn();
    render(
      <GitWorktreeBranchSelector
        groups={groups}
        selectedTarget={groups[0].options[0]}
        onSelectTarget={onSelectTarget}
      />
    );

    fireEvent.click(screen.getByTestId('git-worktree-branch-selector'));

    const searchInput = screen.getByRole('textbox');
    expect(searchInput.className).toContain('text-[11px]');
    expect(searchInput.className).toContain('rounded-none');
    expect(searchInput.className).toContain('leading-normal');
    expect(searchInput.closest('[data-control-frame="true"]')).toBeTruthy();

    // Open Level 2 by clicking the directory row to verify long branch truncation
    fireEvent.click(screen.getByTestId('git-dir-group-dir:main'));
    const longBranchLabel = screen.getByText(
      'member/115d0a52-5063-55a2-a17d-f15b7fd6a0b3/2e8266c3-658f-5fe7-9553-05283d9e95c6'
    );
    expect(longBranchLabel.className).toContain('truncate');
    expect(longBranchLabel.getAttribute('title')).toBe(
      'member/115d0a52-5063-55a2-a17d-f15b7fd6a0b3/2e8266c3-658f-5fe7-9553-05283d9e95c6'
    );

    fireEvent.change(searchInput, { target: { value: 'canvas-audit' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(
      screen.getByRole('option', { name: /canvas-audit-fixes/ })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('option', { name: /canvas-audit-fixes/ }));
    expect(onSelectTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'branch',
        branch: 'canvas-audit-fixes',
      })
    );
  });
});

describe('resolveDefaultLogBranches & GitLogBranchFilter', () => {
  it('defaults to default directory current branch plus origin target branch', () => {
    const branches = [
      makeBranch('feat/ui', { is_current: true }),
      makeBranch('main'),
      makeBranch('origin/main', { is_remote: true }),
      makeBranch('origin/feat/ui', { is_remote: true }),
    ];

    expect(
      resolveDefaultLogBranches({
        defaultCurrentBranch: 'feat/ui',
        branches,
        defaultTargetBranch: 'main',
      })
    ).toEqual(['feat/ui', 'origin/main']);
  });

  it('falls back cleanly when origin target branch is absent', () => {
    const branches = [makeBranch('main', { is_current: true })];

    expect(
      resolveDefaultLogBranches({
        defaultCurrentBranch: 'main',
        branches,
        defaultTargetBranch: 'main',
      })
    ).toEqual(['main']);
  });

  it('displays primary local branch plus extra count on compact trigger and separates Local/Remote tabs without All option', () => {
    const branches = [
      makeBranch('master', { is_current: true }),
      makeBranch('feat/a'),
      makeBranch('feat/b'),
      makeBranch('origin/master', { is_remote: true }),
      makeBranch('origin/dev', { is_remote: true }),
    ];
    const onChange = vi.fn();

    const { rerender } = render(
      <GitLogBranchFilter
        branches={branches}
        selectedBranches={[
          'origin/master',
          'master',
          'feat/a',
          'feat/b',
          'origin/dev',
        ]}
        defaultBranches={['master', 'origin/master']}
        onChange={onChange}
      />
    );

    const trigger = screen.getByTestId('git-log-branch-filter');
    expect(trigger.className).not.toContain('astryx-multi-selector');
    expect(trigger.textContent).toContain('master');
    expect(screen.getByTestId('git-log-branch-extra-count').textContent).toBe(
      '+4'
    );

    // Open popover: Local & Remote tabs, no "全部" option
    fireEvent.click(trigger);
    expect(screen.queryByText('全部')).toBeNull();
    const localTab = screen.getByRole('tab', { name: /本地/ });
    const remoteTab = screen.getByRole('tab', { name: /远程/ });
    expect(localTab.getAttribute('aria-selected')).toBe('true');

    // Local tab lists only local branches
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'feat/a' })
    ).toBeTruthy();
    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'origin/dev' })
    ).toBeNull();

    // Unchecking feat/a calls onChange without feat/a
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'feat/a' }));
    expect(onChange).toHaveBeenCalledWith([
      'origin/master',
      'master',
      'feat/b',
      'origin/dev',
    ]);

    // Switching to Remote tab shows only remote branches
    onChange.mockClear();
    fireEvent.click(remoteTab);
    expect(remoteTab.getAttribute('aria-selected')).toBe('true');
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'origin/dev' })
    ).toBeTruthy();
    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'feat/a' })
    ).toBeNull();

    // Clicking reset restores defaultBranches
    fireEvent.click(screen.getByRole('button', { name: '默认' }));
    expect(onChange).toHaveBeenCalledWith(['master', 'origin/master']);

    // Single selected branch hides +N badge
    rerender(
      <GitLogBranchFilter
        branches={branches}
        selectedBranches={['master']}
        defaultBranches={['master', 'origin/master']}
        onChange={onChange}
      />
    );
    expect(screen.queryByTestId('git-log-branch-extra-count')).toBeNull();
  });
});
