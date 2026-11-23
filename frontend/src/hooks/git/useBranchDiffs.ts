import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { repoApi } from '@/lib/api';
import type { Diff, GitFileStatusEntry } from 'shared/types';

interface UseBranchDiffsOptions {
  repoId: string | null;
  branch: string | null;
  baseBranch?: string | null;
  enabled?: boolean;
}

interface UseBranchDiffsReturn {
  diffs: Diff[];
  files: GitFileStatusEntry[];
  totalAdditions: number;
  totalDeletions: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_DIFFS: Diff[] = [];

function mapDiffChangeToStatus(change: Diff['change']): string {
  switch (change) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'permissionChange':
      return 'T';
    case 'modified':
    default:
      return 'M';
  }
}

export function diffsToStatusEntries(diffs: Diff[]): GitFileStatusEntry[] {
  return diffs.map((diff) => ({
    path: diff.newPath || diff.oldPath || '',
    status: mapDiffChangeToStatus(diff.change),
    additions: diff.additions ?? 0,
    deletions: diff.deletions ?? 0,
  }));
}

export function useBranchDiffs({
  repoId,
  branch,
  baseBranch = null,
  enabled = true,
}: UseBranchDiffsOptions): UseBranchDiffsReturn {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ['branchDiffs', repoId, branch, baseBranch] as const,
    [repoId, branch, baseBranch]
  );

  const {
    data,
    isLoading,
    error: queryError,
  } = useQuery<Diff[]>({
    queryKey,
    queryFn: async () => repoApi.getBranchDiffs(repoId!, branch!, baseBranch),
    enabled: enabled && !!repoId && !!branch,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });

  const diffs = data ?? EMPTY_DIFFS;
  const files = useMemo(() => diffsToStatusEntries(diffs), [diffs]);
  const { totalAdditions, totalDeletions } = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { totalAdditions: additions, totalDeletions: deletions };
  }, [files]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    diffs,
    files,
    totalAdditions,
    totalDeletions,
    isLoading,
    error: queryError
      ? queryError instanceof Error
        ? queryError.message
        : String(queryError)
      : null,
    refresh,
  };
}
