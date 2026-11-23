import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { repoApi } from '@/lib/api';
import type { GitWorktreeInfo } from 'shared/types';

interface UseRepoWorktreesOptions {
  repoId: string | null;
  enabled?: boolean;
}

interface UseRepoWorktreesReturn {
  worktrees: GitWorktreeInfo[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_WORKTREES: GitWorktreeInfo[] = [];

export function useRepoWorktrees({
  repoId,
  enabled = true,
}: UseRepoWorktreesOptions): UseRepoWorktreesReturn {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['repoWorktrees', repoId] as const, [repoId]);

  const {
    data,
    isLoading,
    error: queryError,
  } = useQuery<GitWorktreeInfo[]>({
    queryKey,
    queryFn: async () => repoApi.listWorktrees(repoId!),
    enabled: enabled && !!repoId,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    worktrees: data ?? EMPTY_WORKTREES,
    isLoading,
    error: queryError
      ? queryError instanceof Error
        ? queryError.message
        : String(queryError)
      : null,
    refresh,
  };
}
