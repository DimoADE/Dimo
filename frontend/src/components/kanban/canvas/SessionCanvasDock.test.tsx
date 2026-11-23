import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { getTerminalShellOptions } from '@/lib/terminalPreferences';
import { terminalHostPlatform } from '@/utils/platform';
import { SessionCanvasDock } from './SessionCanvasDock';

const mockPluginPanels = vi.hoisted(() =>
  vi.fn<
    () => Array<{
      pluginId: string;
      id: string;
      kind: 'app_panel';
      label: string;
      generation: number;
      metadata?: Record<string, unknown>;
    }>
  >(() => [])
);

vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions: () => mockPluginPanels(),
  contributionMetadata: (item: { metadata?: Record<string, unknown> }) =>
    item.metadata ?? {},
}));

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents: () => [
    {
      agentId: 'codex',
      displayName: 'Codex',
      enabled: true,
      lifecycle: 'installed',
    },
  ],
}));

function renderDock({
  onCreateGroup = vi.fn(),
  onCreateSession = vi.fn(),
  onCreateSessionWithExecutor = vi.fn(),
  onCreatePanelNode = vi.fn(),
  orientation = 'horizontal' as 'horizontal' | 'vertical',
  menuSide,
}: {
  onCreateGroup?: ReturnType<typeof vi.fn>;
  onCreateSession?: ReturnType<typeof vi.fn>;
  onCreateSessionWithExecutor?: ReturnType<typeof vi.fn>;
  onCreatePanelNode?: ReturnType<typeof vi.fn>;
  orientation?: 'horizontal' | 'vertical';
  menuSide?: 'top' | 'left' | 'right';
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SessionCanvasDock
        selectedCount={0}
        selectedExpanded={false}
        orientation={orientation}
        menuSide={menuSide}
        onCreateGroup={onCreateGroup}
        onCreateSession={onCreateSession}
        onCreateSessionWithExecutor={onCreateSessionWithExecutor}
        onCreatePanelNode={onCreatePanelNode}
        onImportByProject={vi.fn()}
        onImportByRecent={vi.fn()}
        onImportByAgent={vi.fn()}
        onFitView={vi.fn()}
        onAutoArrange={vi.fn()}
        onExpandSelection={vi.fn()}
        onCollapseSelection={vi.fn()}
        onDeleteSelection={vi.fn()}
      />
    </QueryClientProvider>
  );
  return {
    onCreateGroup,
    onCreateSession,
    onCreateSessionWithExecutor,
    onCreatePanelNode,
  };
}

describe('SessionCanvasDock', () => {
  it('opens create options from plus and keeps icons on import options', async () => {
    mockPluginPanels.mockReturnValue([]);
    const user = userEvent.setup();
    const { onCreateGroup, onCreateSession } = renderDock();

    await user.click(screen.getByRole('button', { name: '新建' }));
    const createMenu = await screen.findByRole('menu');
    expect(createMenu).toHaveAttribute('data-align', 'start');
    await user.click(await screen.findByRole('menuitem', { name: '新建分组' }));
    expect(onCreateGroup).toHaveBeenCalledTimes(1);
    expect(onCreateSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '新建会话' }));
    expect(onCreateSession).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '导入会话' }));
    const importMenu = await screen.findByRole('menu');
    expect(importMenu).toHaveAttribute('data-align', 'start');
    const project = await screen.findByRole('menuitem', { name: '项目导入' });
    const recent = screen.getByRole('menuitem', { name: '最近时间导入' });
    const agent = screen.getByRole('menuitem', { name: 'Agent 导入' });
    expect(project.querySelector('svg')).toBeTruthy();
    expect(recent.querySelector('svg')).toBeTruthy();
    expect(agent.querySelector('svg')).toBeTruthy();
  });

  it('supports vertical orientation and custom menu side for left/right dock placement', async () => {
    mockPluginPanels.mockReturnValue([]);
    const user = userEvent.setup();
    renderDock({ orientation: 'vertical', menuSide: 'left' });

    const toolbar = screen.getByRole('toolbar', { name: '画布工具' });
    expect(toolbar).toHaveAttribute('aria-orientation', 'vertical');
    expect(toolbar.className).toContain('flex-col');

    await user.click(screen.getByRole('button', { name: '新建' }));
    const createMenu = await screen.findByRole('menu');
    expect(createMenu).toHaveAttribute('data-side', 'left');
  });

  it('shows the requested groups and omits session details from the create menu', async () => {
    mockPluginPanels.mockReturnValue([]);
    const user = userEvent.setup();
    renderDock();
    await user.click(screen.getByRole('button', { name: '新建' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveTextContent('Agent');
    expect(menu).toHaveTextContent('画布');
    expect(menu).toHaveTextContent('功能');
    expect(menu).toHaveTextContent('终端');
    expect(menu).not.toHaveTextContent('浏览器');
    expect(menu).not.toHaveTextContent('会话详情');
    expect(menu).not.toHaveTextContent('信息');
  });

  it('shows enabled Agents in the new-session submenu', async () => {
    mockPluginPanels.mockReturnValue([]);
    const user = userEvent.setup();
    const { onCreateSession, onCreateSessionWithExecutor } = renderDock();
    await user.click(screen.getByRole('button', { name: '新建' }));
    const hover = new MouseEvent('pointermove', { bubbles: true });
    Object.defineProperty(hover, 'pointerType', { value: 'mouse' });
    fireEvent(screen.getByRole('menuitem', { name: '新建会话' }), hover);
    await user.click(await screen.findByRole('menuitem', { name: 'Codex' }));
    expect(onCreateSessionWithExecutor).toHaveBeenCalledWith('codex');
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('creates terminal nodes from the terminal item and its shell submenu', async () => {
    mockPluginPanels.mockReturnValue([]);
    const user = userEvent.setup();
    const { onCreatePanelNode } = renderDock();

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '终端' }));
    expect(onCreatePanelNode).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'terminal',
        expanded: true,
        params: expect.objectContaining({
          surface: 'editor',
          tabId: expect.any(String),
          shell: expect.any(String),
        }),
      })
    );

    onCreatePanelNode.mockClear();
    await user.click(screen.getByRole('button', { name: '新建' }));
    const hover = new MouseEvent('pointermove', { bubbles: true });
    Object.defineProperty(hover, 'pointerType', { value: 'mouse' });
    fireEvent(screen.getByRole('menuitem', { name: '终端' }), hover);
    const firstShell = getTerminalShellOptions(
      terminalHostPlatform(undefined)
    )[0];
    expect(firstShell).toBeDefined();
    await user.click(
      await screen.findByRole('menuitem', { name: firstShell.label })
    );
    expect(onCreatePanelNode).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'terminal',
        title: firstShell.label,
        expanded: true,
        params: expect.objectContaining({
          surface: 'editor',
          shell: firstShell.value,
        }),
      })
    );
  });

  it('shows browser and custom plugin panels when installed and opens them as canvas nodes', async () => {
    mockPluginPanels.mockReturnValue([
      {
        pluginId: 'example.browser',
        id: 'browser',
        kind: 'app_panel',
        label: 'Browser',
        generation: 1,
        metadata: {
          engine: 'host-browser',
          icon: 'globe',
          multiInstance: true,
        },
      },
      {
        pluginId: 'example.tools',
        id: 'inspector',
        kind: 'app_panel',
        label: 'Inspector',
        generation: 1,
        metadata: { icon: 'bookmark' },
      },
    ]);
    const user = userEvent.setup();
    const { onCreatePanelNode } = renderDock();

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '浏览器' }));
    expect(onCreatePanelNode).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^plugin:example\.browser\/browser:/),
        component: 'plugin-panel',
        title: 'Browser',
        expanded: true,
        params: {
          pluginId: 'example.browser',
          contributionId: 'browser',
          icon: 'globe',
        },
      })
    );

    onCreatePanelNode.mockClear();
    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Inspector' })
    );
    expect(onCreatePanelNode).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'plugin:example.tools/inspector',
        component: 'plugin-panel',
        title: 'Inspector',
        expanded: true,
        params: {
          pluginId: 'example.tools',
          contributionId: 'inspector',
          icon: 'bookmark',
        },
      })
    );
  });
});
