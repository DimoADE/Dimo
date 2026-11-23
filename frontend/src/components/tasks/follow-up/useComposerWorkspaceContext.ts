import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { DetailedGitStatus, Repo, Workspace } from 'shared/types';
import { deriveWorkspaceRootPath } from '@/components/panels/workspaceRootPath';
import { useOptionalProject } from '@/contexts/ProjectContext';
import { useAttemptBranch } from '@/hooks/useAttemptBranch';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useProjectRepos } from '@/hooks/useProjectRepos';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useTaskAttempt } from '@/hooks/useTaskAttempt';
import { attemptsApi, projectsApi, repoApi } from '@/lib/api';

const EMPTY_REPOS: Repo[] = [];

export function extractDirectoryName(
  path: string | null | undefined
): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\/]+$/, '');
  if (!normalized) return trimmed;
  if (/^[a-zA-Z]:$/.test(normalized)) {
    return `${normalized}\\`;
  }
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

export function useComposerWorkspaceContext({
  workspace,
  workspaceId,
}: {
  workspace?: Workspace;
  workspaceId?: string;
}) {
  const projectContext = useOptionalProject();
  const project = projectContext?.project ?? null;
  const isExplicitNonGitProject = project?.is_git === false;
  const isExplicitGitProject = project?.is_git === true;

  const matchesWorkspace = Boolean(
    workspace && (!workspaceId || workspace.id === workspaceId)
  );
  const { data: fetchedWorkspace } = useTaskAttempt(
    matchesWorkspace ? undefined : workspaceId
  );
  const resolvedWorkspace = matchesWorkspace
    ? workspace
    : (fetchedWorkspace ?? workspace);
  const effectiveProjectId =
    projectContext?.projectId ?? resolvedWorkspace?.project_id ?? undefined;

  const { repos, selectedRepoId } = useAttemptRepo(
    isExplicitNonGitProject ? undefined : workspaceId
  );
  const projectReposQuery = useProjectRepos(effectiveProjectId, {
    enabled: Boolean(effectiveProjectId) && !isExplicitNonGitProject,
  });
  const projectRepos = projectReposQuery.data ?? EMPTY_REPOS;
  const parentHasNoGitRepo =
    isExplicitGitProject &&
    repos.length === 0 &&
    projectReposQuery.isSuccess &&
    projectRepos.length === 0 &&
    Boolean(effectiveProjectId);
  const { data: gitChildren = [] } = useQuery({
    queryKey: ['project-git-children', effectiveProjectId],
    queryFn: () => projectsApi.gitChildren(effectiveProjectId!),
    enabled: parentHasNoGitRepo,
    staleTime: 30_000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === effectiveProjectId
        ? previousData
        : undefined,
  });
  const firstGitChildId = gitChildren[0]?.id ?? undefined;
  const { data: childRepos = [] } = useProjectRepos(firstGitChildId, {
    enabled: parentHasNoGitRepo && Boolean(firstGitChildId),
  });

  const effectiveRepos = useMemo(() => {
    if (isExplicitNonGitProject) return EMPTY_REPOS;
    if (repos.length > 0) return repos;
    if (projectRepos.length > 0) return projectRepos;
    return childRepos;
  }, [childRepos, isExplicitNonGitProject, projectRepos, repos]);

  const primaryRepo = useMemo(() => {
    if (isExplicitNonGitProject) return undefined;
    if (repos.length > 0) {
      return repos.find((repo) => repo.id === selectedRepoId) ?? repos[0];
    }
    return projectRepos[0] ?? childRepos[0];
  }, [
    childRepos,
    isExplicitNonGitProject,
    projectRepos,
    repos,
    selectedRepoId,
  ]);

  const isGitDirectory = isExplicitNonGitProject
    ? false
    : isExplicitGitProject ||
      Boolean(
        resolvedWorkspace?.use_worktree ||
          repos.length > 0 ||
          projectRepos.length > 0 ||
          resolvedWorkspace?.branch?.trim()
      );
  const isWorktreeWorkspace = Boolean(
    isGitDirectory && resolvedWorkspace?.use_worktree
  );

  const workspaceRepoNames = useMemo(
    () => effectiveRepos.map((repo) => ({ name: repo.name, path: repo.path })),
    [effectiveRepos]
  );

  const { data: primaryRepoBranches = [] } = useRepoBranches(primaryRepo?.id, {
    enabled: Boolean(isGitDirectory && primaryRepo?.id),
  });
  const composerWorkspacePath = useMemo(
    () =>
      deriveWorkspaceRootPath(resolvedWorkspace, effectiveRepos) ??
      primaryRepo?.path ??
      project?.root_path?.trim() ??
      undefined,
    [effectiveRepos, primaryRepo?.path, project?.root_path, resolvedWorkspace]
  );

  const { branch: attemptBranch, refetch: refetchAttemptBranch } =
    useAttemptBranch(isGitDirectory ? workspaceId : undefined);

  const mainDirectoryBranch = useMemo(() => {
    if (!isGitDirectory) return null;
    return (
      primaryRepoBranches.find((branch) => branch.is_current)?.name?.trim() ||
      primaryRepo?.default_target_branch?.trim() ||
      null
    );
  }, [isGitDirectory, primaryRepo?.default_target_branch, primaryRepoBranches]);

  const fastBranchName = useMemo(() => {
    if (!isGitDirectory) return null;
    if (isWorktreeWorkspace) {
      return resolvedWorkspace?.branch?.trim() || attemptBranch?.trim() || null;
    }
    return (
      mainDirectoryBranch ||
      resolvedWorkspace?.branch?.trim() ||
      attemptBranch?.trim() ||
      null
    );
  }, [
    attemptBranch,
    isGitDirectory,
    isWorktreeWorkspace,
    mainDirectoryBranch,
    resolvedWorkspace?.branch,
  ]);

  const gitStatusWorkspaceId =
    isWorktreeWorkspace && !parentHasNoGitRepo ? (workspaceId ?? null) : null;
  const { data: fallbackGitStatus } = useQuery<DetailedGitStatus>({
    queryKey: ['gitStatus', gitStatusWorkspaceId, primaryRepo?.id ?? null],
    queryFn: async () =>
      gitStatusWorkspaceId
        ? await attemptsApi.getGitStatus(gitStatusWorkspaceId, primaryRepo!.id)
        : await repoApi.getGitStatus(primaryRepo!.id),
    enabled: Boolean(isGitDirectory && primaryRepo?.id && !fastBranchName),
    staleTime: 15_000,
    placeholderData: (previousData) => previousData,
  });

  const composerBranchName = useMemo(() => {
    if (!isGitDirectory) return null;
    return fastBranchName || fallbackGitStatus?.branch_name?.trim() || null;
  }, [fallbackGitStatus?.branch_name, fastBranchName, isGitDirectory]);

  const composerProjectName = useMemo(() => {
    const folderName = extractDirectoryName(composerWorkspacePath);
    if (!isGitDirectory) {
      return folderName || project?.name?.trim() || null;
    }
    return (
      project?.name?.trim() ||
      projectRepos[0]?.display_name?.trim() ||
      projectRepos[0]?.name?.trim() ||
      primaryRepo?.display_name?.trim() ||
      primaryRepo?.name?.trim() ||
      folderName ||
      null
    );
  }, [
    composerWorkspacePath,
    isGitDirectory,
    primaryRepo?.display_name,
    primaryRepo?.name,
    project?.name,
    projectRepos,
  ]);

  return {
    repos,
    selectedRepoId,
    resolvedWorkspace,
    effectiveProjectId,
    isGitDirectory,
    isWorktreeWorkspace,
    composerProjectName,
    composerWorkspacePath,
    attemptBranch,
    refetchAttemptBranch,
    composerBranchName,
    primaryRepo,
    primaryRepoBranches,
    workspaceRepoNames,
    mainDirectoryBranch,
  };
}
