import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GitLogEntry } from 'shared/types';
import { GitLogView } from './GitLogView';

vi.mock('@/utils/clipboard', () => ({
  writeTextToClipboard: vi.fn(async () => true),
}));

const sampleEntries: GitLogEntry[] = [
  {
    sha: 'abc1234567890',
    summary: 'feat: add branch selector',
    author: 'Alice',
    timestamp: 1700000200,
    refs: ['HEAD -> main'],
    parents: ['def0987654321'],
  },
  {
    sha: 'def0987654321',
    summary: 'chore: initial commit',
    author: 'Alice',
    timestamp: 1700000100,
    refs: ['origin/main'],
    parents: [],
  },
];

describe('GitLogView (real react-virtuoso regression)', () => {
  it('mounts without throwing when hasMore is false in both graph and list modes', () => {
    const { rerender } = render(
      <GitLogView
        entries={sampleEntries}
        total={2}
        ahead={1}
        behind={0}
        upstream="origin/main"
        branchName="main"
        loading={false}
        hasMore={false}
        viewMode="graph"
        workspaceId={null}
        repoId="repo-1"
      />
    );

    expect(screen.getByPlaceholderText('搜索提交...')).toBeTruthy();

    rerender(
      <GitLogView
        entries={sampleEntries}
        total={2}
        ahead={1}
        behind={0}
        upstream="origin/main"
        branchName="main"
        loading={false}
        hasMore={false}
        viewMode="list"
        workspaceId={null}
        repoId="repo-1"
      />
    );

    expect(screen.getByPlaceholderText('搜索提交...')).toBeTruthy();
  });

  it('mounts without throwing when hasMore is true and onLoadMore is provided', () => {
    render(
      <GitLogView
        entries={sampleEntries}
        total={200}
        ahead={1}
        behind={0}
        upstream="origin/main"
        branchName="main"
        loading={false}
        hasMore={true}
        onLoadMore={vi.fn()}
        viewMode="graph"
        workspaceId={null}
        repoId="repo-1"
      />
    );

    expect(screen.getByPlaceholderText('搜索提交...')).toBeTruthy();
  });
});
