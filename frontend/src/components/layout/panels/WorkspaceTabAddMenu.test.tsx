import { fireEvent, render, screen } from '@testing-library/react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceOverlayContext } from '@/contexts/WorkspaceOverlayContext';
import { getTerminalShellOptions } from '@/lib/terminalPreferences';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { WorkspaceTabAddMenu } from './WorkspaceTabAddMenu';

const {
  openDiffPreview,
  openNotes,
  openOrFocusPanel,
  openTerminalEditorTab,
  openPluginPanel,
  openWelcomeTab,
  runInEditorGroup,
  usePluginHostContributions,
  useSelectableAgents,
  usePanels,
  useSlotContributions,
  requestCreateAgentSessionInExecutionArea,
} = vi.hoisted(() => ({
  openDiffPreview: vi.fn(),
  openNotes: vi.fn(),
  openOrFocusPanel: vi.fn(),
  openTerminalEditorTab: vi.fn(),
  openPluginPanel: vi.fn(),
  openWelcomeTab: vi.fn(),
  runInEditorGroup: vi.fn((_groupId: string, action: () => void) => action()),
  usePluginHostContributions: vi.fn((): unknown[] => []),
  useSelectableAgents: vi.fn((): unknown[] => []),
  usePanels: vi.fn((): unknown[] => []),
  useSlotContributions: vi.fn((): unknown[] => []),
  requestCreateAgentSessionInExecutionArea: vi.fn(),
}));

vi.mock('@dimoai/plugin-sdk', () => ({
  usePanels,
  useSlotContributions,
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openDiffPreview,
    openNotes,
    openOrFocusPanel,
    openTerminalEditorTab,
    openPluginPanel,
    openWelcomeTab,
    runInEditorGroup,
  }),
}));

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions,
  contributionMetadata: (item: { metadata?: Record<string, unknown> }) =>
    item.metadata ?? {},
}));

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents,
}));

vi.mock('@/lib/requestCreateSession', () => ({
  requestCreateAgentSessionInExecutionArea,
}));

function headerProps(): IDockviewHeaderActionsProps {
  return {
    api: { setActive: vi.fn() },
    group: {
      id: 'group-editor-1',
      panels: [{ id: 'welcome' }],
    },
    panels: [],
    activePanel: undefined,
    isGroupActive: true,
    headerPosition: 'top',
    containerApi: {},
  } as unknown as IDockviewHeaderActionsProps;
}

describe('WorkspaceTabAddMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePluginHostContributions.mockReturnValue([]);
    usePanels.mockReturnValue([]);
    useSlotContributions.mockReturnValue([]);
    useSelectableAgents.mockReturnValue([
      {
        agentId: 'CODEX',
        displayName: 'Codex',
        enabled: true,
        lifecycle: 'ready',
      },
      {
        agentId: 'CLAUDE_CODE',
        displayName: 'Claude Code',
        enabled: true,
        lifecycle: 'ready',
      },
      {
        agentId: 'DISABLED_AGENT',
        displayName: 'Disabled Agent',
        enabled: false,
        lifecycle: 'ready',
      },
    ]);
  });

  it('offers categorized features, info, an Agent submenu, and terminal from the tab strip', () => {
    const props = headerProps();
    const setTabCreationMenuOpen = vi.fn();

    render(
      <WorkspaceOverlayContext.Provider
        value={{
          setTabCreationMenuOpen,
          setHtmlOverlayOpen: vi.fn(),
          setHtmlOverlayRect: vi.fn(),
          setChromeOccluded: vi.fn(),
          subscribeNativeSurfaceOcclusion: () => () => {},
          registerNativeSurfaceHost: () => () => {},
          ackOverlayReady: () => {},
          waitForOverlayReady: () => Promise.resolve(),
          isOverlayReady: () => true,
        }}
      >
        <WorkspaceTabAddMenu {...props} />
      </WorkspaceOverlayContext.Provider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByText('功能')).toBeVisible();
    expect(screen.getByText('信息')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Agent' })).toBeVisible();
    expect(screen.getByText('其他')).toBeVisible();

    expect(
      screen.queryByRole('menuitem', { name: '文件树' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Git 面板' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: '会话列表' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '欢迎' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '笔记' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '审阅' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '执行进程' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '会话详情' })).toBeVisible();
    expect(
      screen.queryByRole('menuitem', { name: 'Codex' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Claude Code' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '终端' })).toBeVisible();

    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('product-context-menu', 'bg-popover');
    expect(menu).not.toHaveClass('tahoe-popover');
    expect(screen.getByRole('menuitem', { name: '审阅' })).toHaveClass(
      'hover:bg-accent'
    );

    fireEvent.click(screen.getByRole('menuitem', { name: '审阅' }));

    expect(props.api.setActive).toHaveBeenCalledOnce();
    expect(openDiffPreview).toHaveBeenCalledOnce();
    expect(openNotes).not.toHaveBeenCalled();
    expect(openTerminalEditorTab).not.toHaveBeenCalled();
  });

  it('opens feature and info panels in the current group', () => {
    const props = headerProps();
    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '欢迎' }));
    expect(openWelcomeTab).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '笔记' }));

    expect(runInEditorGroup).toHaveBeenCalledWith(
      'group-editor-1',
      expect.any(Function)
    );
    expect(openNotes).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '执行进程' }));
    expect(openOrFocusPanel).toHaveBeenCalledWith(
      PANEL_IDS.PROCESSES,
      '执行进程'
    );
  });

  it('lists enabled agents inside the Agent submenu and creates a session on selection', () => {
    const props = headerProps();
    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent' }));

    expect(screen.getByRole('menuitem', { name: 'Codex' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Claude Code' })).toBeVisible();
    expect(
      screen.queryByRole('menuitem', { name: 'Disabled Agent' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }));

    expect(requestCreateAgentSessionInExecutionArea).toHaveBeenCalledWith(
      'CODEX',
      'group-editor-1'
    );
  });

  it('shows a disabled placeholder in the Agent submenu when no agents are enabled', () => {
    useSelectableAgents.mockReturnValue([]);
    const props = headerProps();
    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent' }));

    expect(
      screen.getByRole('menuitem', { name: '暂无已启用 Agent' })
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('occludes the native surface while the tab creation menu is open', () => {
    const props = headerProps();
    const setTabCreationMenuOpen = vi.fn();

    render(
      <WorkspaceOverlayContext.Provider
        value={{
          setTabCreationMenuOpen,
          setHtmlOverlayOpen: vi.fn(),
          setHtmlOverlayRect: vi.fn(),
          setChromeOccluded: vi.fn(),
          subscribeNativeSurfaceOcclusion: () => () => {},
          registerNativeSurfaceHost: () => () => {},
          ackOverlayReady: () => {},
          waitForOverlayReady: () => Promise.resolve(),
          isOverlayReady: () => true,
        }}
      >
        <WorkspaceTabAddMenu {...props} />
      </WorkspaceOverlayContext.Provider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByRole('menuitem', { name: '审阅' })).toBeVisible();
    expect(setTabCreationMenuOpen).toHaveBeenCalledWith(true);
  });

  it('opens the chosen shell from the terminal submenu in this group', () => {
    const props = headerProps();
    const shell = getTerminalShellOptions()[1] ?? getTerminalShellOptions()[0];
    if (!shell) throw new Error('expected a terminal shell option');

    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }));
    expect(openTerminalEditorTab).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: shell.label }));

    expect(props.api.setActive).toHaveBeenCalledOnce();
    expect(runInEditorGroup).toHaveBeenCalledWith(
      'group-editor-1',
      expect.any(Function)
    );
    expect(openTerminalEditorTab).toHaveBeenCalledWith(shell.value);
  });

  it('does not make the workspace inert while the tab menu is open', () => {
    const props = headerProps();
    const { container } = render(
      <div>
        <main aria-label="Workspace content" />
        <WorkspaceTabAddMenu {...props} />
      </div>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(container).not.toHaveAttribute('aria-hidden', 'true');
  });

  it('opens a plugin panel from the tab creation menu', () => {
    usePluginHostContributions.mockImplementation((kind?: string) =>
      kind === 'app_panel'
        ? [
            {
              pluginId: 'dimo.host-surface',
              id: 'sample-panel',
              label: '示例面板',
              kind: 'app_panel',
              metadata: { icon: 'bookmark' },
            },
          ]
        : []
    );
    const props = headerProps();

    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '示例面板' }));

    expect(openPluginPanel).toHaveBeenCalledWith({
      title: '示例面板',
      pluginId: 'dimo.host-surface',
      contributionId: 'sample-panel',
      icon: 'bookmark',
      multiInstance: false,
      instance: 'focus',
    });
  });

  it('deduplicates browser panel and rail contributions into a single localized Browser item', () => {
    usePluginHostContributions.mockImplementation((kind?: string) => {
      if (kind === 'app_panel') {
        return [
          {
            pluginId: 'dimo.browser',
            id: 'browser',
            label: 'Browser',
            kind: 'app_panel',
            metadata: {
              icon: 'globe',
              multiInstance: true,
              engine: 'host-browser',
            },
          },
        ];
      }
      if (kind === 'app_rail_section') {
        return [
          {
            pluginId: 'dimo.browser',
            id: 'open',
            label: 'Browser',
            kind: 'app_rail_section',
            metadata: {
              icon: 'globe',
              opens: {
                kind: 'app.panel',
                id: 'browser',
                instance: 'focus',
              },
            },
          },
        ];
      }
      return [];
    });
    usePanels.mockReturnValue([
      {
        id: 'browser',
        pluginId: 'dimo.browser',
        title: 'Browser',
        icon: 'globe',
        zone: 'editor',
        multiInstance: true,
        builtin: false,
      },
    ]);
    useSlotContributions.mockReturnValue([
      {
        id: 'open',
        pluginId: 'dimo.browser',
        slot: 'rail.sections',
        label: 'Browser',
        tooltip: 'Browser',
        icon: 'globe',
        metadata: {
          opens: {
            kind: 'app.panel',
            id: 'browser',
            instance: 'focus',
          },
        },
        onActivate: vi.fn(),
      },
    ]);
    const props = headerProps();

    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.queryByRole('menuitem', { name: 'Browser' })).toBeNull();
    const browserItems = screen.getAllByRole('menuitem', { name: '浏览器' });
    expect(browserItems).toHaveLength(1);

    fireEvent.click(browserItems[0]!);
    expect(openPluginPanel).toHaveBeenCalledWith({
      title: '浏览器',
      pluginId: 'dimo.browser',
      contributionId: 'browser',
      icon: 'globe',
      multiInstance: true,
      instance: 'new',
    });
  });

  it('renders the tab add button on B and C tab groups, but not on Zone A or bottom groups', () => {
    const leftProps = headerProps();
    Object.assign(leftProps.group, {
      id: 'group-left',
      panels: [{ id: 'file-tree' }],
    });

    const { unmount: unmountLeft } = render(
      <WorkspaceTabAddMenu {...leftProps} />
    );
    expect(
      screen.queryByRole('button', { name: '新建标签页' })
    ).not.toBeInTheDocument();
    unmountLeft();

    const rightProps = headerProps();
    Object.assign(rightProps.group, {
      id: 'group-right',
      panels: [{ id: 'ai-chat' }],
    });
    const { unmount: unmountRight } = render(
      <WorkspaceTabAddMenu {...rightProps} />
    );
    expect(
      screen.getByRole('button', { name: '新建标签页' })
    ).toBeInTheDocument();
    unmountRight();

    const bottomProps = headerProps();
    Object.assign(bottomProps.group, {
      id: 'group-bottom',
      panels: [{ id: 'terminal' }],
    });
    render(<WorkspaceTabAddMenu {...bottomProps} />);
    expect(
      screen.queryByRole('button', { name: '新建标签页' })
    ).not.toBeInTheDocument();
  });
});
