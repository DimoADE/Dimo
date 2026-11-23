import { fireEvent, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';
import { useCanvasPanelHeaderSlot } from './CanvasPanelHeaderSlotContext';
import { SessionCanvasDetailNode } from './SessionCanvasDetailNode';

vi.mock('./CanvasPanelNodeBody', () => ({
  CanvasPanelNodeBody: () => {
    const slot = useCanvasPanelHeaderSlot();
    return (
      <div data-testid="mock-panel-body">
        {slot
          ? createPortal(
              <div data-testid="portaled-space-member-bar">member-bar</div>,
              slot
            )
          : null}
      </div>
    );
  },
}));

const resizeCard = vi.fn();
const resetCardSize = vi.fn();
const collapseCard = vi.fn();
const openOrFocusPanelNode = vi.fn();

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

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions: () => mockPluginPanels(),
  contributionMetadata: (item: { metadata?: Record<string, unknown> }) =>
    item.metadata ?? {},
}));

const sessionsById = vi.hoisted(
  () =>
    new Map([
      [
        'session-1',
        {
          id: 'session-1',
          fullName: '展开会话',
          updatedAt: '2026-09-01T00:00:00.000Z',
          workspace: { id: 'ws' },
        } as KanbanProjectSessionRecord,
      ],
    ])
);

vi.mock('./CanvasViewContext', () => ({
  useSessionCanvasView: () => ({
    sessionsById,
    sessionsReady: true,
    expandCard: vi.fn(),
    collapseCard,
    removeCard: vi.fn(),
    zoomToCard: vi.fn(),
    previewResize: vi.fn(),
    resizeCard,
    resetCardSize,
    renameGroup: vi.fn(),
    toggleGroupShowAll: vi.fn(),
    openOrFocusPanelNode,
  }),
  useCanvasSession: (sessionId: string) => sessionsById.get(sessionId),
}));

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  NodeResizer: ({
    onResize,
    onResizeEnd,
    lineClassName,
    handleClassName,
  }: {
    onResize?: (
      event: unknown,
      params: { x: number; y: number; width: number; height: number }
    ) => void;
    onResizeEnd?: (
      event: unknown,
      params: { x: number; y: number; width: number; height: number }
    ) => void;
    lineClassName?: string;
    handleClassName?: string;
  }) => (
    <div>
      <span data-testid="resize-line-class">{lineClassName}</span>
      <span data-testid="resize-handle-class">{handleClassName}</span>
      <button
        type="button"
        onClick={() => onResize?.({}, { x: 8, y: 16, width: 700, height: 540 })}
      >
        resize
      </button>
      <button
        type="button"
        onClick={() =>
          onResizeEnd?.({}, { x: 8, y: 16, width: 700, height: 540 })
        }
      >
        resize-end
      </button>
    </div>
  ),
}));

vi.mock('@/components/kanban/session-hub/SessionMonitorCard', () => ({
  SessionMonitorCard: ({
    onZoom,
    onHeaderContextMenu,
    selected,
  }: {
    onZoom?: (session: { id: string }) => void;
    onHeaderContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
    selected?: boolean;
  }) => (
    <div>
      <div
        data-testid="mock-session-header"
        onContextMenu={onHeaderContextMenu}
      />
      <span data-testid="window-selected">{String(!!selected)}</span>
      <button type="button" onClick={() => onZoom?.({ id: 'session-1' })}>
        reset-size
      </button>
    </div>
  ),
}));

describe('SessionCanvasDetailNode', () => {
  it('resizes from the handles and resets to the default window size', () => {
    render(
      <SessionCanvasDetailNode
        id="session-session-1"
        data={{ sessionId: 'session-1' }}
        selected
        type="sessionDetail"
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={1}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    );

    expect(screen.getByTestId('resize-line-class')).toHaveTextContent(
      'canvas-node-resize-line'
    );
    expect(screen.getByTestId('resize-handle-class')).toHaveTextContent(
      'canvas-node-resize-handle'
    );
    fireEvent.click(screen.getByText('resize'));
    fireEvent.click(screen.getByText('resize-end'));
    expect(resizeCard).toHaveBeenCalledWith('session-1', {
      x: 8,
      y: 16,
      width: 700,
      height: 540,
    });
    fireEvent.click(screen.getByText('reset-size'));
    expect(resetCardSize).toHaveBeenCalledWith('session-1');
  });

  it('forwards selected so the session window border can change', () => {
    const { rerender } = render(
      <SessionCanvasDetailNode
        id="session-session-1"
        data={{ sessionId: 'session-1' }}
        selected={false}
        type="sessionDetail"
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={1}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    );
    expect(screen.getByTestId('window-selected')).toHaveTextContent('false');
    rerender(
      <SessionCanvasDetailNode
        id="session-session-1"
        data={{ sessionId: 'session-1' }}
        selected
        type="sessionDetail"
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={1}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    );
    expect(screen.getByTestId('window-selected')).toHaveTextContent('true');
  });

  it('renders a left-aligned header slot for Collaboration Space nodes instead of a static badge title', () => {
    render(
      <TooltipProvider>
        <SessionCanvasDetailNode
          id="panel-collab-1"
          data={{
            sessionId: '',
            instanceId: 'collab-1',
            panelId: 'collaboration-space:space-1',
            panelComponent: 'collaboration-space',
            panelTitle: '设计协作群',
            panelParams: { targetType: 'group', spaceId: 'space-1' },
          }}
          selected
          type="sessionDetail"
          dragging={false}
          draggable
          selectable
          deletable
          zIndex={1}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </TooltipProvider>
    );

    const header = screen.getByTestId('canvas-node-header');
    const slot = screen.getByTestId('canvas-space-header-slot');
    expect(header.firstElementChild).toBe(slot);
    expect(slot).toContainElement(
      screen.getByTestId('portaled-space-member-bar')
    );
    expect(screen.queryByText('设计协作群')).not.toBeInTheDocument();
  });

  it('exposes terminal and installed browser items in session node header context menu', () => {
    openOrFocusPanelNode.mockClear();
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
    ]);

    render(
      <SessionCanvasDetailNode
        id="session-session-1"
        data={{ sessionId: 'session-1', instanceId: 'session-1' }}
        selected
        type="sessionDetail"
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={1}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    );

    fireEvent.contextMenu(screen.getByTestId('mock-session-header'));
    expect(screen.getByRole('menuitem', { name: '终端' })).toBeInTheDocument();
    const browserItem = screen.getByRole('menuitem', { name: '浏览器' });
    fireEvent.click(browserItem);

    expect(openOrFocusPanelNode).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^plugin:example\.browser\/browser:/),
        component: 'plugin-panel',
        title: 'Browser',
        expanded: true,
        parentNodeId: 'session-1',
        params: {
          pluginId: 'example.browser',
          contributionId: 'browser',
          icon: 'globe',
        },
      })
    );

    openOrFocusPanelNode.mockClear();
    fireEvent.contextMenu(screen.getByTestId('mock-session-header'));
    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }));
    expect(openOrFocusPanelNode).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'terminal',
        expanded: true,
        parentNodeId: 'session-1',
        params: expect.objectContaining({
          surface: 'editor',
          tabId: expect.any(String),
          shell: expect.any(String),
        }),
      })
    );
  });

  it('constrains browser website favicon size in the panel node header', () => {
    render(
      <TooltipProvider>
        <SessionCanvasDetailNode
          id="panel-browser-1"
          data={{
            sessionId: '',
            instanceId: 'browser-1',
            panelId: 'plugin:example.browser/browser:1',
            panelComponent: 'plugin-panel',
            panelTitle: 'github.com',
            panelParams: {
              pluginId: 'example.browser',
              contributionId: 'browser',
              faviconUrl: 'https://github.com/favicon.ico',
              requestedUrl: 'https://github.com/',
            },
          }}
          selected
          type="sessionDetail"
          dragging={false}
          draggable
          selectable
          deletable
          zIndex={1}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </TooltipProvider>
    );

    const iconWrapper = screen.getByTestId('workspace-tab-icon');
    const favicon = screen.getByTestId('workspace-tab-favicon');
    expect(iconWrapper).toHaveClass('h-3.5', 'w-3.5', 'shrink-0');
    expect(favicon).toHaveClass('h-full', 'w-full', 'object-contain');
  });
});
