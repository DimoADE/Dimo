import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attemptsApi, repoApi } from '@/lib/api';
import type { GitLogEntry, GitLogStatus } from 'shared/types';

interface UseGitLogOptions {
  workspaceId: string | null;
  repoId: string | null;
  worktreePath?: string | null;
  branches?: string[];
  maxCount?: number;
  enabled?: boolean;
}

interface UseGitLogReturn {
  entries: GitLogEntry[];
  total: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  branchName: string;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_ENTRIES: GitLogEntry[] = [];

export function useGitLog({
  workspaceId,
  repoId,
  worktreePath = null,
  branches,
  maxCount,
  enabled = true,
}: UseGitLogOptions): UseGitLogReturn {
  const queryClient = useQueryClient();
  const normalizedBranches = useMemo(
    () =>
      branches && branches.length > 0 ? [...new Set(branches)].sort() : null,
    [branches]
  );
  const queryKey = useMemo(
    () => [
      'gitLog',
      workspaceId,
      repoId,
      worktreePath,
      normalizedBranches,
      maxCount ?? null,
    ],
    [workspaceId, repoId, worktreePath, normalizedBranches, maxCount]
  );

  const {
    data: logStatus,
    isLoading,
    error: queryError,
  } = useQuery<GitLogStatus>({
    queryKey,
    queryFn: async () => {
      if (worktreePath) {
        return await repoApi.getGitLog(repoId!, {
          worktreePath,
          branches: normalizedBranches ?? undefined,
          maxCount,
        });
      }
      return workspaceId
        ? await attemptsApi.getGitLog(workspaceId, repoId!, {
            branches: normalizedBranches ?? undefined,
            maxCount,
          })
        : await repoApi.getGitLog(repoId!, {
            branches: normalizedBranches ?? undefined,
            maxCount,
          });
    },
    enabled: enabled && !!repoId,
    staleTime: 15_000,
    placeholderData: (previousData) => previousData,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    entries: logStatus?.entries ?? EMPTY_ENTRIES,
    total: logStatus?.total ?? 0,
    ahead: logStatus?.ahead ?? 0,
    behind: logStatus?.behind ?? 0,
    upstream: logStatus?.upstream ?? null,
    branchName: logStatus?.branch_name ?? '',
    isLoading,
    error: queryError
      ? queryError instanceof Error
        ? queryError.message
        : String(queryError)
      : null,
    refresh,
  };
}
