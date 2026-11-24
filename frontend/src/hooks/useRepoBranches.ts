import { useQuery } from '@tanstack/react-query';
import { repoApi } from '@/lib/api';
import type { GitBranch } from 'shared/types';

export const repoBranchKeys = {
  all: ['repoBranches'] as const,
  byRepo: (repoId: string | undefined) => ['repoBranches', repoId] as const,
};

export const GIT_INIT_BRANCH_POLL_MS = 1500;

type BranchQueryState = {
  state: {
    data?: GitBranch[];
    status?: string;
  };
};

export function repoBranchesStaleTime(query: BranchQueryState): number {
  return query.state.data && query.state.data.length > 0 ? 60_000 : 0;
}

export function repoBranchesRefetchInterval(
  query: BranchQueryState
): number | false {
  if (query.state.status === 'error') {
    return GIT_INIT_BRANCH_POLL_MS;
  }
  if (!query.state.data || query.state.data.length === 0) {
    return GIT_INIT_BRANCH_POLL_MS;
  }
  return false;
}

type Options = {
  enabled?: boolean;
};

export function useRepoBranches(repoId?: string | null, opts?: Options) {
  const enabled = (opts?.enabled ?? true) && !!repoId;

  return useQuery<GitBranch[]>({
    queryKey: repoBranchKeys.byRepo(repoId ?? undefined),
    queryFn: () => repoApi.getBranches(repoId!),
    enabled,
    staleTime: repoBranchesStaleTime,
    refetchOnWindowFocus: true,
  });
}
