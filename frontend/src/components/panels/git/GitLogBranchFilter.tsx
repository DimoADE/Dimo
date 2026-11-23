import { memo, useCallback, useMemo, useState } from 'react';
import {
  Check,
  GitBranch as GitBranchIcon,
  Globe,
  RotateCcw,
  Search,
} from 'lucide-react';
import type { GitBranch } from 'shared/types';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import i18n from '@/i18n';

/**
 * Computes the default branch filter for Git Log:
 * the default directory's current branch + the origin target branch (when present).
 */
export function resolveDefaultLogBranches({
  defaultCurrentBranch,
  branches,
  defaultTargetBranch,
  upstream,
}: {
  defaultCurrentBranch: string | null;
  branches: GitBranch[];
  defaultTargetBranch?: string | null;
  upstream?: string | null;
}): string[] {
  const result: string[] = [];
  const addUnique = (ref: string | null | undefined) => {
    const trimmed = ref?.trim();
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  };

  addUnique(defaultCurrentBranch);

  const remoteNames = new Set(
    branches.filter((b) => b.is_remote).map((b) => b.name)
  );

  const remoteCandidates: string[] = [];
  if (defaultTargetBranch?.trim()) {
    const target = defaultTargetBranch.trim();
    remoteCandidates.push(
      target.startsWith('origin/') ? target : `origin/${target}`
    );
  }
  if (upstream?.trim()) {
    remoteCandidates.push(upstream.trim());
  }
  remoteCandidates.push('origin/main', 'origin/master');
  if (defaultCurrentBranch?.trim()) {
    remoteCandidates.push(`origin/${defaultCurrentBranch.trim()}`);
  }

  for (const candidate of remoteCandidates) {
    if (remoteNames.has(candidate)) {
      addUnique(candidate);
      break;
    }
  }

  return result;
}

/**
 * Picks the primary branch name to display on the compact trigger (`<primary> +N`):
 * prefers the selected current local branch, then any selected local branch,
 * and falls back to the first selected branch.
 */
export function resolvePrimarySelectedBranch(
  selectedBranches: string[],
  branches: GitBranch[]
): string | null {
  if (selectedBranches.length === 0) return null;
  const branchByName = new Map(branches.map((b) => [b.name, b]));

  const currentSelected = selectedBranches.find((name) => {
    const b = branchByName.get(name);
    return b && !b.is_remote && b.is_current;
  });
  if (currentSelected) return currentSelected;

  const localSelected = selectedBranches.find((name) => {
    const b = branchByName.get(name);
    return b ? !b.is_remote : !name.startsWith('origin/');
  });
  if (localSelected) return localSelected;

  return selectedBranches[0];
}

type BranchFilterTab = 'local' | 'remote';

interface GitLogBranchFilterProps {
  branches: GitBranch[];
  selectedBranches: string[];
  defaultBranches: string[];
  onChange: (nextBranches: string[]) => void;
}

export const GitLogBranchFilter = memo(function GitLogBranchFilter({
  branches,
  selectedBranches,
  defaultBranches,
  onChange,
}: GitLogBranchFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { localBranches, remoteBranches } = useMemo(() => {
    const local: GitBranch[] = [];
    const remote: GitBranch[] = [];
    for (const branch of branches) {
      if (branch.is_remote) {
        remote.push(branch);
      } else {
        local.push(branch);
      }
    }
    return { localBranches: local, remoteBranches: remote };
  }, [branches]);

  const [activeTab, setActiveTab] = useState<BranchFilterTab>(() =>
    localBranches.length > 0 ? 'local' : 'remote'
  );

  const effectiveTab: BranchFilterTab =
    activeTab === 'remote' && remoteBranches.length === 0
      ? 'local'
      : activeTab === 'local' && localBranches.length === 0
        ? 'remote'
        : activeTab;

  const selectedSet = useMemo(
    () => new Set(selectedBranches),
    [selectedBranches]
  );

  const localSelectedCount = useMemo(
    () => localBranches.filter((b) => selectedSet.has(b.name)).length,
    [localBranches, selectedSet]
  );

  const remoteSelectedCount = useMemo(
    () => remoteBranches.filter((b) => selectedSet.has(b.name)).length,
    [remoteBranches, selectedSet]
  );

  const isDefaultSelected = useMemo(() => {
    if (selectedBranches.length !== defaultBranches.length) return false;
    return defaultBranches.every((b) => selectedSet.has(b));
  }, [selectedBranches.length, defaultBranches, selectedSet]);

  const primaryBranch = useMemo(
    () => resolvePrimarySelectedBranch(selectedBranches, branches),
    [selectedBranches, branches]
  );

  const extraCount = Math.max(0, selectedBranches.length - 1);

  const visibleBranches = useMemo(() => {
    const list = effectiveTab === 'local' ? localBranches : remoteBranches;
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((b) => b.name.toLowerCase().includes(q));
  }, [effectiveTab, localBranches, remoteBranches, search]);

  const handleToggleBranch = useCallback(
    (branchName: string) => {
      if (selectedSet.has(branchName)) {
        const next = selectedBranches.filter((b) => b !== branchName);
        if (next.length === 0) return;
        onChange(next);
      } else {
        onChange([...selectedBranches, branchName]);
      }
    },
    [selectedSet, selectedBranches, onChange]
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearch('');
    }
  }, []);

  const triggerTooltip =
    selectedBranches.length > 0
      ? selectedBranches.join(', ')
      : i18n.t('panels:ui.gitLog.branchesFilter');

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="git-log-branch-filter"
          title={triggerTooltip}
          aria-label={i18n.t('panels:ui.gitLog.branchesFilter')}
          className={`inline-flex h-6 max-w-[132px] shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors ${
            open
              ? 'border-primary/50 bg-accent/60 text-foreground'
              : 'border-border/60 bg-transparent text-foreground hover:border-border hover:bg-accent/50'
          }`}
        >
          <GitBranchIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono leading-none">
            {primaryBranch ?? i18n.t('panels:ui.gitLog.branchesFilter')}
          </span>
          {extraCount > 0 && (
            <span
              data-testid="git-log-branch-extra-count"
              className="shrink-0 font-mono text-[10px] leading-none text-muted-foreground"
            >
              +{extraCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={4}
        className="w-60 p-0 overflow-hidden"
      >
        {/* Tabs header: Local / Remote + optional Reset to default */}
        <div className="flex items-center justify-between gap-1 border-b border-border/40 px-2 pt-1.5 pb-1">
          <div
            role="tablist"
            aria-label={i18n.t('panels:ui.gitLog.branchesFilter')}
            className="flex items-center gap-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === 'local'}
              disabled={localBranches.length === 0}
              onClick={() => setActiveTab('local')}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                effectiveTab === 'local'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }`}
            >
              <GitBranchIcon className="h-2.5 w-2.5 shrink-0" />
              <span>{i18n.t('panels:ui.gitLog.presetLocal')}</span>
              {localSelectedCount > 0 && (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {localSelectedCount}
                </span>
              )}
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === 'remote'}
              disabled={remoteBranches.length === 0}
              onClick={() => setActiveTab('remote')}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                effectiveTab === 'remote'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }`}
            >
              <Globe className="h-2.5 w-2.5 shrink-0" />
              <span>{i18n.t('panels:ui.gitLog.remoteTab')}</span>
              {remoteSelectedCount > 0 && (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {remoteSelectedCount}
                </span>
              )}
            </button>
          </div>

          {!isDefaultSelected && defaultBranches.length > 0 && (
            <button
              type="button"
              onClick={() => onChange(defaultBranches)}
              title={i18n.t('panels:ui.gitLog.presetDefault')}
              aria-label={i18n.t('panels:ui.gitLog.presetDefault')}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              <span>{i18n.t('panels:ui.gitLog.presetDefault')}</span>
            </button>
          )}
        </div>

        {/* Compact branch filter input */}
        {branches.length > 6 && (
          <div className="border-b border-border/30 px-2 py-1.5">
            <div className="flex h-6 items-center gap-1.5 rounded border border-border/60 bg-background/60 px-2 focus-within:border-primary/60">
              <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={i18n.t('panels:ui.git.filterBranches')}
                className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
          </div>
        )}

        {/* Branch checkbox list for the active tab */}
        <div
          role="tabpanel"
          className="max-h-56 overflow-y-auto p-1 space-y-0.5"
        >
          {visibleBranches.length === 0 ? (
            <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              {i18n.t('panels:ui.git.noBranchesFound')}
            </div>
          ) : (
            visibleBranches.map((branch) => {
              const checked = selectedSet.has(branch.name);
              const isOnlySelected = checked && selectedBranches.length === 1;
              return (
                <button
                  key={branch.name}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  disabled={isOnlySelected}
                  onClick={() => handleToggleBranch(branch.name)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground transition-colors hover:bg-accent/60 disabled:cursor-default disabled:opacity-75"
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border transition-colors ${
                      checked
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40 bg-transparent'
                    }`}
                  >
                    {checked && (
                      <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono leading-tight">
                    {branch.name}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
