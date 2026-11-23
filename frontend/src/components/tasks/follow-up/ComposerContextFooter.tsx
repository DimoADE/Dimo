import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {
  Check,
  ChevronDown,
  Copy,
  Folder,
  FolderGit2,
  GitBranch,
  Shield,
  ShieldOff,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentSessionConfigOption, AgentSessionMode } from 'shared/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ConversationSessionModesState } from '@/features/conversation/conversationStore';
import { cn } from '@/lib/utils';
import {
  configOptionDisplayState,
  resolvedConfigOptionChoices,
  visibleSessionConfigOptions,
} from './SessionConfigOptionSelectors';
import {
  isDangerousPermissionsMode,
  presentableSessionModes,
} from './SessionModeSelector';
import { compactSessionControlLabel } from './sessionControlLabels';
import type { ComposerWorkspaceSwitcherConfig } from './useComposerWorkspaceSwitcher';

type SwitcherMode = 'workspace' | 'branch';

const MAIN_DIRECTORY_CHIP_CLASS =
  'shrink-0 rounded-full bg-[hsl(var(--success)/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--success))]';

const WORKSPACE_COPY_BUTTON_CLASS =
  'pointer-events-none absolute inset-y-0 z-[1] inline-flex items-center bg-accent pl-3 text-muted-foreground opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:text-foreground';

const UNRESTRICTED_PERMISSION_TOKENS = new Set([
  'fullaccess',
  'agentfullaccess',
  'dangerfullaccess',
  'bypasspermissions',
  'yolo',
  'alwaysapprove',
  'unrestricted',
]);

export interface ComposerPermissionChoice {
  value: string;
  label: string;
  description?: string | null;
}

export interface ResolvedComposerPermissionControl {
  source: 'mode' | 'config';
  optionKey?: string;
  title: string;
  activeValue: string | null;
  activeLabel: string;
  unrestricted: boolean;
  hasDangerousMode: boolean;
  choices: ComposerPermissionChoice[];
}

function normalizedPermissionToken(value: string | null | undefined): string {
  return (value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function isUnrestrictedPermissionMode(
  value: string | null | undefined,
  label?: string | null
): boolean {
  const normalizedValue = normalizedPermissionToken(value);
  const normalizedLabel = normalizedPermissionToken(label);
  if (
    UNRESTRICTED_PERMISSION_TOKENS.has(normalizedValue) ||
    UNRESTRICTED_PERMISSION_TOKENS.has(normalizedLabel) ||
    normalizedValue.includes('yolo') ||
    normalizedLabel.includes('yolo')
  ) {
    return true;
  }
  return (label ?? '').trim() === '完全访问';
}

function isModeConfigOption(option: AgentSessionConfigOption): boolean {
  const key = (option.key ?? '').trim().toLowerCase().replaceAll('-', '_');
  const category = (option.category ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('-', '_');
  const label = (option.label ?? '').trim().toLowerCase();
  return category === 'mode' || key === 'mode' || label === 'mode';
}

function isPermissionConfigOption(option: AgentSessionConfigOption): boolean {
  if (typeof option.value === 'boolean') return false;
  const text =
    `${option.category ?? ''} ${option.key} ${option.label}`.toLowerCase();
  return text.includes('permission') || text.includes('approval');
}

export function resolveComposerPermissionControl({
  sessionModes,
  selectedMode = null,
  sessionConfigOptions = [],
  selectedConfigValues = {},
  dangerousOperationsAllowed = false,
  defaultTitle,
}: {
  sessionModes?: { current: string | null; modes: AgentSessionMode[] };
  selectedMode?: string | null;
  sessionConfigOptions?: AgentSessionConfigOption[];
  selectedConfigValues?: Record<string, string>;
  dangerousOperationsAllowed?: boolean;
  defaultTitle: string;
}): ResolvedComposerPermissionControl | null {
  const modes = sessionModes?.modes ?? [];
  const activeModeId = selectedMode ?? sessionModes?.current ?? null;

  if (modes.length > 0) {
    const hasDangerousMode = modes.some((mode) =>
      isDangerousPermissionsMode(mode.id)
    );
    const presentable = presentableSessionModes(
      modes,
      dangerousOperationsAllowed,
      activeModeId
    );
    const activeMode =
      presentable.find((mode) => mode.id === activeModeId) ??
      modes.find((mode) => mode.id === activeModeId) ??
      null;
    const activeLabel = activeMode
      ? compactSessionControlLabel(activeMode.id, activeMode.label).trim()
      : activeModeId
        ? compactSessionControlLabel(activeModeId, activeModeId).trim()
        : '';

    if (activeLabel) {
      return {
        source: 'mode',
        title: defaultTitle,
        activeValue: activeModeId,
        activeLabel,
        unrestricted: isUnrestrictedPermissionMode(activeModeId, activeLabel),
        hasDangerousMode,
        choices: presentable.map((mode) => ({
          value: mode.id,
          label: mode.label,
          description: mode.description,
        })),
      };
    }
  }

  const visibleOptions = visibleSessionConfigOptions(sessionConfigOptions);
  const configOption =
    visibleOptions.find(isModeConfigOption) ??
    visibleOptions.find(isPermissionConfigOption) ??
    null;

  if (!configOption) {
    return null;
  }

  const choices = resolvedConfigOptionChoices(
    configOption,
    visibleOptions,
    selectedConfigValues
  );
  const { displayChoices, presentedActiveValue } = configOptionDisplayState(
    configOption,
    selectedConfigValues[configOption.key] ?? null,
    choices
  );
  const activeChoice = displayChoices.find(
    (choice) => choice.value === presentedActiveValue
  );
  const activeLabel = (
    activeChoice?.name ??
    compactSessionControlLabel(presentedActiveValue, presentedActiveValue)
  ).trim();

  if (!activeLabel) {
    return null;
  }

  return {
    source: 'config',
    optionKey: configOption.key,
    title: configOption.label || defaultTitle,
    activeValue: presentedActiveValue || null,
    activeLabel,
    unrestricted: isUnrestrictedPermissionMode(
      presentedActiveValue,
      activeLabel
    ),
    hasDangerousMode: false,
    choices: displayChoices.map((choice) => ({
      value: choice.value,
      label: choice.name,
      description: choice.description,
    })),
  };
}

export interface ComposerContextFooterProps {
  useWorktree: boolean;
  projectName?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  workspaceSwitcher?: ComposerWorkspaceSwitcherConfig | null;
  sessionModes?: ConversationSessionModesState;
  selectedMode?: string | null;
  onSelectMode?: (modeId: string) => void;
  sessionConfigOptions?: AgentSessionConfigOption[];
  selectedConfigValues?: Record<string, string>;
  onSelectConfigOption?: (key: string, value: string) => void;
  disabled?: boolean;
}

export function ComposerContextFooter({
  useWorktree,
  projectName = null,
  workspacePath = null,
  branchName = null,
  workspaceSwitcher = null,
  sessionModes,
  selectedMode = null,
  onSelectMode,
  sessionConfigOptions = [],
  selectedConfigValues = {},
  onSelectConfigOption,
  disabled = false,
}: ComposerContextFooterProps) {
  const { t } = useTranslation(['conversation', 'tasks', 'panels']);
  const activeModeId = selectedMode ?? sessionModes?.current ?? null;
  const [dangerousOperationsAllowed, setDangerousOperationsAllowed] = useState(
    () => isDangerousPermissionsMode(activeModeId)
  );
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [switcherMode, setSwitcherMode] = useState<SwitcherMode>('workspace');
  const [copiedWorkspaceId, setCopiedWorkspaceId] = useState<string | null>(
    null
  );
  const copiedResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (isDangerousPermissionsMode(activeModeId)) {
      setDangerousOperationsAllowed(true);
    }
  }, [activeModeId]);

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
    };
  }, []);

  const permissionControl = useMemo(
    () =>
      resolveComposerPermissionControl({
        sessionModes,
        selectedMode,
        sessionConfigOptions,
        selectedConfigValues,
        dangerousOperationsAllowed,
        defaultTitle: t('tasks:sessionModeSelector.title'),
      }),
    [
      dangerousOperationsAllowed,
      selectedConfigValues,
      selectedMode,
      sessionConfigOptions,
      sessionModes,
      t,
    ]
  );

  const directoryLabel = useWorktree
    ? t('conversation:composerContext.worktree')
    : projectName?.trim() || t('conversation:composerContext.defaultDirectory');
  const normalizedBranch = branchName?.trim() || null;
  const DirectoryIcon = useWorktree ? FolderGit2 : Folder;
  const PermissionIcon = permissionControl?.unrestricted ? ShieldOff : Shield;

  const canSwitchWorkspace = Boolean(
    !disabled &&
      workspaceSwitcher &&
      !workspaceSwitcher.disabled &&
      (workspaceSwitcher.workspaces.length > 0 ||
        workspaceSwitcher.canEnsureDefaultDirectory ||
        (workspaceSwitcher.canSwitchBranch &&
          workspaceSwitcher.branches.length > 0))
  );

  const canSelectPermission = Boolean(
    !disabled &&
      permissionControl &&
      ((permissionControl.source === 'mode' &&
        onSelectMode &&
        (permissionControl.choices.length > 1 ||
          permissionControl.hasDangerousMode)) ||
        (permissionControl.source === 'config' &&
          permissionControl.optionKey &&
          onSelectConfigOption &&
          permissionControl.choices.length > 1))
  );

  const handleWorkspaceMenuOpenChange = useCallback((next: boolean) => {
    setWorkspaceMenuOpen(next);
    if (next) {
      setSwitcherMode('workspace');
    }
  }, []);

  const handleCopyWorkspacePath = useCallback(
    async (
      event: MouseEvent<HTMLButtonElement>,
      workspaceId: string,
      copyPath: string
    ) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(copyPath);
        setCopiedWorkspaceId(workspaceId);
        if (copiedResetTimerRef.current) {
          window.clearTimeout(copiedResetTimerRef.current);
        }
        copiedResetTimerRef.current = window.setTimeout(() => {
          setCopiedWorkspaceId((current) =>
            current === workspaceId ? null : current
          );
        }, 1800);
      } catch (error) {
        console.warn('Copy workspace path failed:', error);
      }
    },
    []
  );

  const handleSelectPermission = (value: string) => {
    if (!permissionControl) return;
    if (permissionControl.source === 'mode') {
      onSelectMode?.(value);
      return;
    }
    if (permissionControl.optionKey) {
      onSelectConfigOption?.(permissionControl.optionKey, value);
    }
  };

  return (
    <div
      className="composer-cockpit-footer"
      data-testid="composer-context-footer"
      role="region"
      aria-label={t('conversation:composerContext.regionLabel')}
    >
      {canSwitchWorkspace && workspaceSwitcher ? (
        <DropdownMenu
          modal={false}
          open={workspaceMenuOpen}
          onOpenChange={handleWorkspaceMenuOpenChange}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="composer-cockpit-footer-trigger composer-cockpit-footer-directory"
              data-testid="composer-footer-directory"
              data-directory-kind={useWorktree ? 'worktree' : 'default'}
              disabled={workspaceSwitcher.isSwitching}
              aria-label={t(
                'conversation:composerContext.switchWorkspaceLabel',
                { workspace: directoryLabel }
              )}
              title={workspacePath || directoryLabel}
            >
              <DirectoryIcon
                className="h-3.5 w-3.5 shrink-0 opacity-80"
                aria-hidden="true"
              />
              <span className="truncate">{directoryLabel}</span>
              <ChevronDown
                className="h-3 w-3 shrink-0 opacity-65"
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-64 overflow-hidden p-0"
          >
            {workspaceSwitcher.canSwitchBranch ? (
              <div
                className="border-b border-border/60 p-2"
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <SegmentedControl
                  className="w-full [&_.astryx-segmented-control-item]:!text-[0.625rem]"
                  layout="fill"
                  size="sm"
                  value={switcherMode}
                  onChange={(value) => {
                    if (value === 'workspace' || value === 'branch') {
                      setSwitcherMode(value);
                    }
                  }}
                  label={t('panels:worktreeSelector.modeLabel')}
                  data-testid="composer-workspace-switcher-mode"
                >
                  <SegmentedControlItem
                    value="workspace"
                    label={t('panels:worktreeSelector.modeWorkspace')}
                    icon={
                      <FolderGit2 aria-hidden="true" className="size-full" />
                    }
                  />
                  <SegmentedControlItem
                    value="branch"
                    label={t('panels:worktreeSelector.modeBranch')}
                    icon={
                      <GitBranch aria-hidden="true" className="size-full" />
                    }
                  />
                </SegmentedControl>
              </div>
            ) : null}

            <div
              className="max-h-72 overflow-y-auto overscroll-contain p-1"
              data-testid="composer-workspace-switcher-list"
            >
              {switcherMode === 'workspace' ? (
                workspaceSwitcher.workspaces.length > 0 ||
                workspaceSwitcher.canEnsureDefaultDirectory ? (
                  <>
                    {workspaceSwitcher.canEnsureDefaultDirectory &&
                    workspaceSwitcher.onSelectDefaultDirectory ? (
                      <DropdownMenuItem
                        className="min-w-0 gap-2"
                        onSelect={(event) => {
                          event.preventDefault();
                          setWorkspaceMenuOpen(false);
                          void workspaceSwitcher.onSelectDefaultDirectory?.();
                        }}
                      >
                        <Folder
                          className="h-3.5 w-3.5 shrink-0 opacity-75"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {workspaceSwitcher.defaultDirectoryLabel}
                        </span>
                        <span className={MAIN_DIRECTORY_CHIP_CLASS}>
                          {t('panels:worktreeSelector.mainDirectory')}
                        </span>
                      </DropdownMenuItem>
                    ) : null}

                    {workspaceSwitcher.workspaces.map((option) => {
                      const OptionIcon = option.isWorktree
                        ? FolderGit2
                        : Folder;
                      const copyLabel = option.copyPath
                        ? copiedWorkspaceId === option.id
                          ? t('panels:worktreeSelector.copiedWorkspacePath')
                          : t('panels:worktreeSelector.copyWorkspacePath')
                        : t('panels:worktreeSelector.noCopyablePath');

                      return (
                        <div key={option.id} className="group relative">
                          <DropdownMenuItem
                            className="min-w-0 gap-2 group-hover:bg-accent"
                            onSelect={(event) => {
                              event.preventDefault();
                              setWorkspaceMenuOpen(false);
                              void workspaceSwitcher.onSelectWorkspace(
                                option.workspace
                              );
                            }}
                          >
                            <OptionIcon
                              className="h-3.5 w-3.5 shrink-0 opacity-75"
                              aria-hidden="true"
                            />
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate text-xs',
                                option.isWorktree ? 'font-mono' : 'font-medium'
                              )}
                            >
                              {option.label}
                            </span>
                            {!option.isWorktree ? (
                              <span className={MAIN_DIRECTORY_CHIP_CLASS}>
                                {t('panels:worktreeSelector.mainDirectory')}
                              </span>
                            ) : null}
                            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                              {option.isSelected ? (
                                <Check
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5"
                                />
                              ) : null}
                            </span>
                          </DropdownMenuItem>
                          {option.copyPath ? (
                            <button
                              type="button"
                              className={cn(
                                WORKSPACE_COPY_BUTTON_CLASS,
                                option.isWorktree
                                  ? 'right-8'
                                  : 'right-[5.25rem]'
                              )}
                              aria-label={copyLabel}
                              title={copyLabel}
                              data-testid="composer-workspace-copy-path"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={(event) =>
                                void handleCopyWorkspacePath(
                                  event,
                                  option.id,
                                  option.copyPath!
                                )
                              }
                            >
                              {copiedWorkspaceId === option.id ? (
                                <Check className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    {t('panels:worktreeSelector.emptyWorkspaces')}
                  </p>
                )
              ) : workspaceSwitcher.branches.length > 0 ? (
                workspaceSwitcher.branches.map((entry) => (
                  <DropdownMenuItem
                    key={`${entry.role}:${entry.name}`}
                    className="gap-2"
                    onSelect={(event) => {
                      event.preventDefault();
                      setWorkspaceMenuOpen(false);
                      void workspaceSwitcher.onSelectBranch?.(entry);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {entry.name}
                    </span>
                    {entry.role === 'main-directory' ? (
                      <span className={MAIN_DIRECTORY_CHIP_CLASS}>
                        {t('panels:worktreeSelector.mainDirectory')}
                      </span>
                    ) : null}
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {entry.role === 'current' ? (
                        <Check aria-hidden="true" className="h-3.5 w-3.5" />
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                ))
              ) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t('panels:worktreeSelector.emptyBranches')}
                </p>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div
          className="composer-cockpit-footer-left"
          data-testid="composer-footer-directory"
          data-directory-kind={useWorktree ? 'worktree' : 'default'}
          title={workspacePath || directoryLabel}
        >
          <DirectoryIcon
            className="h-3.5 w-3.5 shrink-0 opacity-80"
            aria-hidden="true"
          />
          <span className="truncate">{directoryLabel}</span>
        </div>
      )}

      <div className="composer-cockpit-footer-right">
        {normalizedBranch ? (
          <span
            className="composer-cockpit-footer-item composer-cockpit-footer-branch"
            data-testid="composer-footer-branch"
            title={t('conversation:composerContext.branchLabel', {
              branch: normalizedBranch,
            })}
          >
            <GitBranch
              className="h-3.5 w-3.5 shrink-0 opacity-80"
              aria-hidden="true"
            />
            <span className="truncate">{normalizedBranch}</span>
          </span>
        ) : null}

        {permissionControl ? (
          canSelectPermission ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="composer-cockpit-footer-trigger"
                  data-testid="composer-footer-permission"
                  data-permission-unrestricted={
                    permissionControl.unrestricted ? 'true' : undefined
                  }
                  aria-label={t(
                    'conversation:composerContext.permissionLabel',
                    {
                      mode: permissionControl.activeLabel,
                    }
                  )}
                  title={t('conversation:composerContext.permissionLabel', {
                    mode: permissionControl.activeLabel,
                  })}
                >
                  <PermissionIcon
                    className="h-3.5 w-3.5 shrink-0 opacity-80"
                    aria-hidden="true"
                  />
                  <span className="truncate">
                    {permissionControl.activeLabel}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="end"
                sideOffset={8}
                className="min-w-[13rem] max-w-[18rem]"
              >
                <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {permissionControl.title}
                </DropdownMenuLabel>
                {permissionControl.choices.map((choice) => {
                  const isActive =
                    choice.value === permissionControl.activeValue;
                  return (
                    <DropdownMenuItem
                      key={choice.value}
                      onSelect={() => handleSelectPermission(choice.value)}
                      title={choice.description ?? undefined}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {choice.label}
                      </span>
                      {isActive ? (
                        <Check
                          className="h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
                {permissionControl.source === 'mode' &&
                permissionControl.hasDangerousMode ? (
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      setDangerousOperationsAllowed((prev) => !prev);
                    }}
                    className="mt-1 border-t border-border/60"
                  >
                    <span className="min-w-0 flex-1 text-muted-foreground">
                      {t('tasks:sessionModeSelector.allowDangerousOperations')}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                        dangerousOperationsAllowed
                          ? 'bg-primary/12 text-primary'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {dangerousOperationsAllowed
                        ? t('tasks:sessionSettings.on')
                        : t('tasks:sessionSettings.off')}
                    </span>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span
              className="composer-cockpit-footer-item"
              data-testid="composer-footer-permission"
              data-permission-unrestricted={
                permissionControl.unrestricted ? 'true' : undefined
              }
              title={t('conversation:composerContext.permissionLabel', {
                mode: permissionControl.activeLabel,
              })}
            >
              <PermissionIcon
                className="h-3.5 w-3.5 shrink-0 opacity-80"
                aria-hidden="true"
              />
              <span className="truncate">{permissionControl.activeLabel}</span>
            </span>
          )
        ) : null}
      </div>
    </div>
  );
}
