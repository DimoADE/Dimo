import {
  memo,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { ViewportPortal } from '@xyflow/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { applyDragOverlayToCanvasNodes, worldRect } from './canvasGrouping';
import {
  CARD_HEIGHT,
  handleAnchor,
  type CanvasHandleSide,
  type SessionCanvasLink,
  type SessionCanvasNode,
} from './canvasModel';

export type CanvasDragOverlayMap = ReadonlyMap<
  string,
  { x: number; y: number }
>;

export interface CanvasDragOverlayStore {
  getSnapshot: () => CanvasDragOverlayMap;
  subscribe: (listener: () => void) => () => void;
}

export interface CanvasConnectingState {
  sourceId: string;
  sourceHandle: CanvasHandleSide;
  currentFlowPoint: { x: number; y: number };
  hoveredTarget: { nodeId: string; side: CanvasHandleSide } | null;
}

export interface CanvasLinksLayerProps {
  activeCanvasId: string;
  layoutNodes: readonly SessionCanvasNode[];
  dragOverlayStore: CanvasDragOverlayStore;
  sessionLinks: readonly SessionCanvasLink[];
  connectingState: CanvasConnectingState | null;
  disconnectLinkLabel: string;
  onDisconnectLink: (link: SessionCanvasLink) => void;
}

function linkAnchor(
  nodes: readonly SessionCanvasNode[],
  node: SessionCanvasNode,
  side?: CanvasHandleSide
): { x: number; y: number } {
  const rect = worldRect(nodes, node);
  if (side) {
    return handleAnchor(rect, side);
  }
  if (node.expanded) {
    return { x: rect.x + rect.width / 2, y: rect.y + CARD_HEIGHT / 2 };
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Renders session links and in-progress handle connection previews in their
 * own subscription boundary so live node-drag position overlays and link hover
 * states never re-render the entire SessionCanvasFlow tree.
 */
export const CanvasLinksLayer = memo(function CanvasLinksLayer({
  activeCanvasId,
  layoutNodes,
  dragOverlayStore,
  sessionLinks,
  connectingState,
  disconnectLinkLabel,
  onDisconnectLink,
}: CanvasLinksLayerProps) {
  const dragOverlay = useSyncExternalStore(
    dragOverlayStore.subscribe,
    dragOverlayStore.getSnapshot,
    dragOverlayStore.getSnapshot
  );
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);

  useEffect(() => {
    setHoveredLinkId(null);
  }, [activeCanvasId]);

  const liveNodes = useMemo(
    () =>
      dragOverlay.size === 0
        ? layoutNodes
        : applyDragOverlayToCanvasNodes(layoutNodes, dragOverlay),
    [dragOverlay, layoutNodes]
  );

  const nodeMap = useMemo(() => {
    const map = new Map<string, SessionCanvasNode>();
    for (const node of liveNodes) {
      map.set(node.id, node);
    }
    return map;
  }, [liveNodes]);

  const resolvedLinks = useMemo(() => {
    const items: Array<{
      link: SessionCanvasLink;
      start: { x: number; y: number };
      end: { x: number; y: number };
      midX: number;
      midY: number;
    }> = [];
    for (const link of sessionLinks) {
      const from = nodeMap.get(link.sourceId);
      const to = nodeMap.get(link.targetId);
      if (!from || !to) continue;
      const start = linkAnchor(liveNodes, from, link.sourceHandle);
      const end = linkAnchor(liveNodes, to, link.targetHandle);
      items.push({
        link,
        start,
        end,
        midX: (start.x + end.x) / 2,
        midY: (start.y + end.y) / 2,
      });
    }
    return items;
  }, [liveNodes, nodeMap, sessionLinks]);

  const connectingPreview = useMemo(() => {
    if (!connectingState) return null;
    const sourceNode = nodeMap.get(connectingState.sourceId);
    if (!sourceNode) return null;
    const start = linkAnchor(
      liveNodes,
      sourceNode,
      connectingState.sourceHandle
    );
    if (
      connectingState.hoveredTarget &&
      connectingState.hoveredTarget.nodeId !== connectingState.sourceId
    ) {
      const targetNode = nodeMap.get(connectingState.hoveredTarget.nodeId);
      if (targetNode) {
        const end = linkAnchor(
          liveNodes,
          targetNode,
          connectingState.hoveredTarget.side
        );
        return { start, end };
      }
    }
    return { start, end: connectingState.currentFlowPoint };
  }, [connectingState, liveNodes, nodeMap]);

  if (resolvedLinks.length === 0 && !connectingPreview) {
    return null;
  }

  return (
    <ViewportPortal>
      <svg
        className="pointer-events-none absolute overflow-visible"
        width={1}
        height={1}
      >
        {resolvedLinks.map(({ link, start, end }) => (
          <g key={link.id}>
            <line
              className="canvas-session-link"
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              strokeDasharray="6 4"
              strokeWidth={hoveredLinkId === link.id ? 2.4 : 1.75}
            />
            <line
              data-testid={`canvas-link-hit-${link.id}`}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke="transparent"
              strokeWidth={16}
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onMouseEnter={() => setHoveredLinkId(link.id)}
              onMouseLeave={() =>
                setHoveredLinkId((prev) => (prev === link.id ? null : prev))
              }
            />
          </g>
        ))}
        {connectingPreview ? (
          <line
            data-testid="canvas-link-preview"
            className="canvas-session-link"
            x1={connectingPreview.start.x}
            y1={connectingPreview.start.y}
            x2={connectingPreview.end.x}
            y2={connectingPreview.end.y}
            strokeDasharray="4 4"
            strokeWidth={2}
          />
        ) : null}
      </svg>
      {resolvedLinks.map(({ link, midX, midY }) => {
        const isHovered = hoveredLinkId === link.id;
        return (
          <button
            key={`disconnect-${link.id}`}
            type="button"
            data-testid={`canvas-link-disconnect-${link.id}`}
            aria-label={disconnectLinkLabel}
            title={disconnectLinkLabel}
            onMouseEnter={() => setHoveredLinkId(link.id)}
            onMouseLeave={() =>
              setHoveredLinkId((prev) => (prev === link.id ? null : prev))
            }
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              setHoveredLinkId((prev) => (prev === link.id ? null : prev));
              onDisconnectLink(link);
            }}
            className={cn(
              'nodrag nopan pointer-events-auto absolute z-30 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm transition-opacity hover:border-destructive/60 hover:bg-destructive hover:text-destructive-foreground',
              isHovered
                ? 'opacity-100'
                : 'opacity-0 hover:opacity-100 focus:opacity-100'
            )}
            style={{
              left: midX,
              top: midY,
            }}
          >
            <X className="size-3" />
          </button>
        );
      })}
    </ViewportPortal>
  );
});
