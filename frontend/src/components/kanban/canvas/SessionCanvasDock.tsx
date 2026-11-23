import { useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  Bot,
  Clock,
  Download,
  Expand,
  FileDiff,
  FileText,
  Folder,
  Globe,
  LayoutGrid,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Plus,
  Puzzle,
  SquareDashed,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { openWorkspaceTerminal } from '@/components/layout/panels/openWorkspaceTerminal';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { useOptionalWorktree } from '@/contexts/WorktreeContext';
import { useOptionalCollaborationSpaceStore } from '@/features/collaboration/space/SpaceStoreContext';
import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import { findHostBrowserContribution } from '@/features/host-browser/hostBrowserEngine';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import {
  getDefaultTerminalShell,
  getTerminalShellOptions,
  getTerminalWorkspaceKey,
} from '@/lib/terminalPreferences';
import { cn } from '@/lib/utils';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { terminalHostPlatform } from '@/utils/platform';
import {
  buildCanvasPluginPanelRequest,
  buildCanvasTerminalPanelRequest,
} from './canvasPanelRequests';
import type { OpenCanvasPanelRequest } from './canvasWorkspaceBridge';

const DOCK_BUTTON_SHAPE =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors';

const DOCK_BUTTON = `${DOCK_BUTTON_SHAPE} text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40`;

const DOCK_BUTTON_DANGER = `${DOCK_BUTTON_SHAPE} text-muted-foreground hover:bg-destructive/10 hover:text-destructive`;

function DockButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={danger ? DOCK_BUTTON_DANGER : DOCK_BUTTON}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function DockDivider({ vertical }: { vertical?: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 bg-border',
        vertical ? 'my-1 h-px w-5' : 'mx-1 h-5 w-px'
      )}
      aria-hidden="true"
    />
  );
}

export function SessionCanvasDock({
  selectedCount,
  selectedExpanded,
  selectedIsGroup = false,
  selectedGroupCollapsed = false,
  orientation = 'horizontal',
  menuSide,
  onToggleGroupCollapse,
  onCreateGroup,
  onCreateSession,
  onCreateSessionWithExecutor,
  onCreatePanelNode,
  onImportByProject,
  onImportByRecent,
  onImportByAgent,
  onFitView,
  onAutoArrange,
  onExpandSelection,
  onCollapseSelection,
  onDeleteSelection,
}: {
  selectedCount: number;
  selectedExpanded: boolean;
  selectedIsGroup?: boolean;
  selectedGroupCollapsed?: boolean;
  orientation?: 'horizontal' | 'vertical';
  menuSide?: 'top' | 'left' | 'right';
  onToggleGroupCollapse?: () => void;
  onCreateGroup: () => void;
  onCreateSession: () => void;
  onCreateSessionWithExecutor?: (executor: string) => void;
  onCreatePanelNode?: (request: OpenCanvasPanelRequest) => void;
  onImportByProject: () => void;
  onImportByRecent: () => void;
  onImportByAgent: () => void;
  onFitView: () => void;
  onAutoArrange: () => void;
  onExpandSelection: () => void;
  onCollapseSelection: () => void;
  onDeleteSelection: () => void;
}) {
  const { t } = useTranslation(['tasks', 'panels']);
  const system = useOptionalUserSystem();
  const worktree = useOptionalWorktree();
  const collaboration = useOptionalCollaborationSpaceStore();
  const pluginPanels = usePluginHostContributions('app_panel');
  const selectableAgents = useSelectableAgents();
  const [createMenuOpen, setCreateMenuOpen] = useState(false);

  const enabledAgents = useMemo(() => {
    return selectableAgents.filter(isEnabledInstalledAgent).map((agent) => ({
      id: agent.agentId,
      label: agent.displayName || getAgentName(agent.agentId),
    }));
  }, [selectableAgents]);

  const hostPlatform = terminalHostPlatform(system?.environment?.os_type);
  const shells = getTerminalShellOptions(hostPlatform);
  const defaultShell = getDefaultTerminalShell(
    system?.config,
    system?.environment?.os_type
  );
  const browser = findHostBrowserContribution(pluginPanels);
  const nonBrowserPlugins = useMemo(
    () =>
      pluginPanels.filter(
        (item) =>
          !browser ||
          item.pluginId !== browser.pluginId ||
          item.id !== browser.id
      ),
    [browser, pluginPanels]
  );

  const openTerminalNode = (shell?: string) => {
    openWorkspaceTerminal({
      shell,
      defaultShell,
      workspaceId: getTerminalWorkspaceKey(worktree?.activeWorktreeId ?? null),
      openInEditor: (chosenShell) => {
        onCreatePanelNode?.(
          buildCanvasTerminalPanelRequest({
            shell: chosenShell,
            shells,
            fallbackTitle: t('panels:tabCreation.terminal', '终端'),
          })
        );
      },
      onExternalError: (error) => {
        toast.error(t('panels:terminalHeader.openExternalFailed'), {
          description:
            error instanceof Error
              ? error.message
              : t('panels:terminalHeader.confirmWarpInstalled'),
        });
      },
    });
  };

  const isVertical = orientation === 'vertical';
  const resolvedMenuSide = menuSide ?? (isVertical ? 'right' : 'top');

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 rounded-full border border-border',
        isVertical ? 'flex-col' : 'flex-row',
        'bg-[var(--surface-card-strong)] p-1 shadow-[var(--shadow-popover)]'
      )}
      role="toolbar"
      aria-orientation={orientation}
      aria-label={t('hubCanvas.dock')}
    >
      <DropdownMenu open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={DOCK_BUTTON}
            aria-label={t('hubCanvas.createMenu')}
            title={t('hubCanvas.createMenu')}
          >
            <Plus className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side={resolvedMenuSide}
          className="max-h-[420px] min-w-[200px] overflow-y-auto"
        >
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {t('panels:tabCreation.agentGroup', 'Agent')}
          </DropdownMenuLabel>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onCreateSession();
                  setCreateMenuOpen(false);
                }
              }}
              onClick={() => {
                onCreateSession();
                setCreateMenuOpen(false);
              }}
            >
              <MessageSquarePlus className="size-4 text-muted-foreground" />
              {t('hubCanvas.createSession')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {enabledAgents.length === 0 ? (
                <DropdownMenuItem disabled>
                  {t('hubCanvas.noEnabledAgents')}
                </DropdownMenuItem>
              ) : null}
              {enabledAgents.map((agent) => (
                <DropdownMenuItem
                  key={agent.id}
                  onSelect={() => {
                    if (onCreateSessionWithExecutor) {
                      onCreateSessionWithExecutor(agent.id);
                    } else {
                      onCreateSession();
                    }
                  }}
                >
                  <span aria-hidden="true">
                    <AgentIcon agent={agent.id} className="size-4 shrink-0" />
                  </span>
                  {agent.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            disabled={!collaboration}
            onSelect={() =>
              collaboration?.getSnapshot().openCreateMemberDialog()
            }
          >
            <Bot className="size-4 text-muted-foreground" />
            {t('hubCanvas.createAssistant')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!collaboration}
            onSelect={() =>
              collaboration?.getSnapshot().openCreateSpaceDialog()
            }
          >
            <Bot className="size-4 text-muted-foreground" />
            {t('hubCanvas.createGroupChat')}
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {t('hubCanvas.canvasGroup')}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={onCreateGroup}>
            <SquareDashed className="size-4 text-muted-foreground" />
            {t('hubCanvas.createGroup')}
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {t('panels:tabCreation.featuresGroup', '功能')}
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() =>
              onCreatePanelNode?.({
                id: PANEL_IDS.DIFFS,
                component: PANEL_IDS.DIFFS,
                title: t('panels:tabCreation.review', '审阅'),
                expanded: true,
              })
            }
          >
            <FileDiff className="size-4 text-muted-foreground" />
            {t('panels:tabCreation.review', '审阅')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              onCreatePanelNode?.({
                id: PANEL_IDS.NOTES,
                component: PANEL_IDS.NOTES,
                title: t('panels:tabCreation.note', '笔记'),
                expanded: true,
              })
            }
          >
            <FileText className="size-4 text-muted-foreground" />
            {t('panels:tabCreation.note', '笔记')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              onCreatePanelNode?.({
                id: PANEL_IDS.PROCESSES,
                component: PANEL_IDS.PROCESSES,
                title: t('panels:tabCreation.processes', '执行进程'),
                expanded: true,
              })
            }
          >
            <Activity className="size-4 text-muted-foreground" />
            {t('panels:tabCreation.processes', '执行进程')}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openTerminalNode();
                  setCreateMenuOpen(false);
                }
              }}
              onClick={() => {
                openTerminalNode();
                setCreateMenuOpen(false);
              }}
            >
              <SquareTerminal className="size-4 text-muted-foreground" />
              {t('panels:tabCreation.terminal', '终端')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {shells.map((shell) => (
                <DropdownMenuItem
                  key={shell.value}
                  onSelect={() => openTerminalNode(shell.value)}
                >
                  {shell.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {browser ? (
            <DropdownMenuItem
              onSelect={() =>
                onCreatePanelNode?.(
                  buildCanvasPluginPanelRequest(browser, {
                    forceMultiInstance: true,
                    fallbackIcon: 'globe',
                  })
                )
              }
            >
              <Globe className="size-4 text-muted-foreground" />
              {t('panels:tabCreation.browser', '浏览器')}
            </DropdownMenuItem>
          ) : null}
          {nonBrowserPlugins.map((item) => {
            const metadata = contributionMetadata(item);
            const icon =
              typeof metadata.icon === 'string' ? metadata.icon : null;
            const Icon = contributionIconComponent(icon, Puzzle);
            return (
              <DropdownMenuItem
                key={`${item.pluginId}:${item.id}`}
                onSelect={() =>
                  onCreatePanelNode?.(buildCanvasPluginPanelRequest(item))
                }
              >
                <Icon className="size-4 text-muted-foreground" />
                {item.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={DOCK_BUTTON}
            aria-label={t('hubCanvas.importMenu')}
            title={t('hubCanvas.importMenu')}
          >
            <Download className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side={resolvedMenuSide}>
          <DropdownMenuItem onSelect={onImportByProject}>
            <Folder className="size-4 text-muted-foreground" />
            {t('hubCanvas.importByProject')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onImportByRecent}>
            <Clock className="size-4 text-muted-foreground" />
            {t('hubCanvas.importByRecent')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onImportByAgent}>
            <Bot className="size-4 text-muted-foreground" />
            {t('hubCanvas.importByAgent')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DockButton label={t('hubCanvas.fitView')} onClick={onFitView}>
        <Maximize2 className="size-4" />
      </DockButton>
      <DockButton label={t('hubCanvas.autoArrange')} onClick={onAutoArrange}>
        <LayoutGrid className="size-4" />
      </DockButton>
      {selectedCount > 0 ? (
        <>
          <DockDivider vertical={isVertical} />
          {selectedIsGroup ? (
            <DockButton
              label={
                selectedGroupCollapsed
                  ? t('hubCanvas.expandGroupFrame')
                  : t('hubCanvas.collapseGroupFrame')
              }
              onClick={() => onToggleGroupCollapse?.()}
            >
              {selectedGroupCollapsed ? (
                <Expand className="size-4" />
              ) : (
                <Minimize2 className="size-4" />
              )}
            </DockButton>
          ) : selectedExpanded ? (
            <DockButton
              label={t('hubCanvas.collapseCard')}
              onClick={onCollapseSelection}
            >
              <Minimize2 className="size-4" />
            </DockButton>
          ) : (
            <DockButton
              label={t('hubCanvas.expandCard')}
              onClick={onExpandSelection}
            >
              <Expand className="size-4" />
            </DockButton>
          )}
          <DockButton
            label={t('hubCanvas.removeCard')}
            danger
            onClick={onDeleteSelection}
          >
            <Trash2 className="size-4" />
          </DockButton>
        </>
      ) : null}
    </div>
  );
}
