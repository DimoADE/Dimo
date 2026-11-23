import { create } from 'zustand';
import type { Diff } from 'shared/types';

export type DiffReviewSource =
  | {
      kind: 'worktree';
      repoId: string;
      worktreePath: string | null;
      workspaceId: string | null;
      label: string;
      branch: string | null;
      isMain: boolean;
    }
  | {
      kind: 'branch';
      repoId: string;
      branch: string;
      baseBranch: string | null;
      diffs: Diff[];
      isLoading?: boolean;
    };

interface GitDiffNavigationState {
  targetPath: string | null;
  requestToken: number;
  reviewSource: DiffReviewSource | null;
  focusPath: (path: string) => void;
  clearTargetPath: () => void;
  setReviewSource: (source: DiffReviewSource | null) => void;
  clearReviewSource: () => void;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

export const useGitDiffNavigationStore = create<GitDiffNavigationState>(
  (set) => ({
    targetPath: null,
    requestToken: 0,
    reviewSource: null,
    focusPath: (path) =>
      set((state) => ({
        targetPath: normalizePath(path),
        requestToken: state.requestToken + 1,
      })),
    clearTargetPath: () => set({ targetPath: null }),
    setReviewSource: (reviewSource) => set({ reviewSource }),
    clearReviewSource: () => set({ reviewSource: null }),
  })
);
