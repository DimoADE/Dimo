import { Orientation, type SerializedDockview } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';
import { terminalShelfGroupId } from '@/lib/terminalShelf';
import { MIN_RIGHT_PANEL_WIDTH, useLayoutStore } from '@/stores/useLayoutStore';
import {
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isRightShellNavGroup,
  isSessionGroup,
} from '@/utils/dockviewGroupPolicy';
import {
  defaultSessionPanelWidth,
  settleDockviewGroupWidths,
} from '@/utils/dockviewStartupSizing';
import { MIN_LEFT_PANEL_WIDTH } from '@/utils/dockviewWorkspaceConstraints';

type DockviewGroup = NonNullable<ReturnType<DockviewApi['getGroup']>>;

const LEFT_DOCK_DEFAULT_RATIO = 0.1;
const SECONDARY_DOCK_WIDTH = 220;
const MIN_FLEX_COLUMN_WIDTH = 200;
const MIN_VERTICAL_ROW_HEIGHT = 140;

interface SerializedGridNode {
  type?: string;
  size?: number;
  visible?: boolean;
  data?: unknown;
}

function defaultPrimaryDockWidth(gridWidth: number): number {
  return Math.max(
    MIN_LEFT_PANEL_WIDTH,
    Math.round(gridWidth * LEFT_DOCK_DEFAULT_RATIO)
  );
}

function isTerminalShelfGroup(group: DockviewGroup): boolean {
  return isBottomGroup(group) || group.id === terminalShelfGroupId();
}

function findFirstVisibleGroup(
  node: SerializedGridNode | null | undefined,
  groupById: ReadonlyMap<string, DockviewGroup>
): DockviewGroup | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'leaf') {
    const data = node.data as { id?: unknown } | undefined;
    const id = typeof data?.id === 'string' ? data.id : '';
    const group = id ? groupById.get(id) : undefined;
    return group && group.api.isVisible ? group : null;
  }
  if (node.type === 'branch' && Array.isArray(node.data)) {
    for (const child of node.data) {
      const found = findFirstVisibleGroup(
        child as SerializedGridNode,
        groupById
      );
      if (found) return found;
    }
  }
  return null;
}

function collectVisibleGroups(
  node: SerializedGridNode | null | undefined,
  groupById: ReadonlyMap<string, DockviewGroup>,
  out: DockviewGroup[] = []
): DockviewGroup[] {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'leaf') {
    const data = node.data as { id?: unknown } | undefined;
    const id = typeof data?.id === 'string' ? data.id : '';
    const group = id ? groupById.get(id) : undefined;
    if (group && group.api.isVisible) {
      out.push(group);
    }
    return out;
  }
  if (node.type === 'branch' && Array.isArray(node.data)) {
    for (const child of node.data) {
      collectVisibleGroups(child as SerializedGridNode, groupById, out);
    }
  }
  return out;
}

function classifyHorizontalChild(
  groups: readonly DockviewGroup[]
): 'primaryDock' | 'secondaryDock' | 'session' | 'editor' {
  if (
    groups.every((group) => isLeftGroup(group) && !isRightShellNavGroup(group))
  ) {
    return 'primaryDock';
  }
  if (groups.every((group) => isLeftGroup(group))) {
    return 'secondaryDock';
  }
  if (groups.every((group) => isSessionGroup(group))) {
    return 'session';
  }
  return 'editor';
}

function arrangeBranch(
  node: SerializedGridNode,
  axis: 'horizontal' | 'vertical',
  box: { width: number; height: number },
  gridWidth: number,
  groupById: ReadonlyMap<string, DockviewGroup>,
  isRoot: boolean
): void {
  if (node.type !== 'branch' || !Array.isArray(node.data)) return;

  const visibleChildren = (node.data as SerializedGridNode[])
    .map((child) => ({
      child,
      groups: collectVisibleGroups(child, groupById),
      rep: findFirstVisibleGroup(child, groupById),
    }))
    .filter(
      (
        entry
      ): entry is {
        child: SerializedGridNode;
        groups: DockviewGroup[];
        rep: DockviewGroup;
      } => entry.groups.length > 0 && entry.rep !== null
    );

  if (visibleChildren.length === 0) return;

  const nextAxis = axis === 'horizontal' ? 'vertical' : 'horizontal';

  if (axis === 'horizontal') {
    const totalWidth =
      box.width > 0
        ? box.width
        : visibleChildren.reduce((sum, entry) => sum + entry.rep.api.width, 0);

    if (visibleChildren.length > 1 && totalWidth > 0) {
      const classified = visibleChildren.map((entry) => ({
        ...entry,
        kind: isRoot
          ? classifyHorizontalChild(entry.groups)
          : ('editor' as const),
      }));
      const hasEditor = classified.some((entry) => entry.kind === 'editor');

      const fixedWidths = new Map<DockviewGroup, number>();
      let reservedWidth = 0;
      const flexEntries: typeof classified = [];

      for (const entry of classified) {
        if (entry.kind === 'primaryDock') {
          const width = defaultPrimaryDockWidth(gridWidth || totalWidth);
          fixedWidths.set(entry.rep, width);
          reservedWidth += width;
        } else if (entry.kind === 'secondaryDock') {
          fixedWidths.set(entry.rep, SECONDARY_DOCK_WIDTH);
          reservedWidth += SECONDARY_DOCK_WIDTH;
        } else if (entry.kind === 'session' && hasEditor) {
          const width = defaultSessionPanelWidth(
            gridWidth || totalWidth,
            MIN_RIGHT_PANEL_WIDTH
          );
          fixedWidths.set(entry.rep, width);
          reservedWidth += width;
        } else {
          flexEntries.push(entry);
        }
      }

      const flexBudget = Math.max(
        flexEntries.length * MIN_FLEX_COLUMN_WIDTH,
        totalWidth - reservedWidth
      );
      const flexWidth =
        flexEntries.length > 0
          ? Math.round(flexBudget / flexEntries.length)
          : 0;

      const widthTargets = classified.map((entry) => ({
        group: entry.rep,
        width: fixedWidths.get(entry.rep) ?? flexWidth,
      }));
      settleDockviewGroupWidths(widthTargets);

      for (const entry of classified) {
        const childWidth = fixedWidths.get(entry.rep) ?? flexWidth;
        arrangeBranch(
          entry.child,
          nextAxis,
          { width: childWidth, height: box.height },
          gridWidth,
          groupById,
          false
        );
      }
      return;
    }

    for (const entry of visibleChildren) {
      arrangeBranch(
        entry.child,
        nextAxis,
        { width: totalWidth, height: box.height },
        gridWidth,
        groupById,
        false
      );
    }
    return;
  }

  // Vertical branch: balance stacked rows while keeping terminal shelf tidy.
  const totalHeight =
    box.height > 0
      ? box.height
      : visibleChildren.reduce((sum, entry) => sum + entry.rep.api.height, 0);

  const heightByRep = new Map<DockviewGroup, number>();
  if (visibleChildren.length > 1 && totalHeight > 0) {
    const shelfEntries = visibleChildren.filter((entry) =>
      entry.groups.every((group) => isTerminalShelfGroup(group))
    );
    const otherEntries = visibleChildren.filter(
      (entry) => !shelfEntries.includes(entry)
    );

    const targets: Array<{ group: DockviewGroup; height: number }> = [];
    if (shelfEntries.length > 0 && otherEntries.length > 0) {
      const maxShelfBudget = Math.max(
        MIN_VERTICAL_ROW_HEIGHT,
        totalHeight - otherEntries.length * MIN_VERTICAL_ROW_HEIGHT
      );
      const shelfHeight = Math.min(
        DEFAULT_TERMINAL_PANEL_HEIGHT,
        Math.floor(maxShelfBudget / shelfEntries.length)
      );
      const remaining = Math.max(
        otherEntries.length * MIN_VERTICAL_ROW_HEIGHT,
        totalHeight - shelfHeight * shelfEntries.length
      );
      const rowHeight = Math.round(remaining / otherEntries.length);

      for (const entry of visibleChildren) {
        const height = shelfEntries.includes(entry) ? shelfHeight : rowHeight;
        targets.push({ group: entry.rep, height });
        heightByRep.set(entry.rep, height);
      }
    } else {
      const equalHeight = Math.round(totalHeight / visibleChildren.length);
      for (const entry of visibleChildren) {
        targets.push({ group: entry.rep, height: equalHeight });
        heightByRep.set(entry.rep, equalHeight);
      }
    }

    for (let pass = 0; pass < 4; pass += 1) {
      let stable = true;
      for (const target of targets.toReversed()) {
        if (Math.abs(target.group.api.height - target.height) > 1) {
          target.group.api.setSize({ height: target.height });
          stable = false;
        }
      }
      if (stable) break;
    }
  }

  for (const entry of visibleChildren) {
    arrangeBranch(
      entry.child,
      nextAxis,
      {
        width: box.width,
        height: heightByRep.get(entry.rep) ?? totalHeight,
      },
      gridWidth,
      groupById,
      false
    );
  }
}

/**
 * Tidy the live Dockview workspace layout in-place without unmounting any open
 * tabs (editors, browsers, terminals, or sessions): restores default dock /
 * session / terminal proportions and equalizes split editor columns & rows.
 */
export function autoArrangeDockviewLayout(api: DockviewApi): boolean {
  const visibleGroups = api.groups.filter((group) => group.api.isVisible);
  if (visibleGroups.length === 0) return false;

  // Drop empty non-primary editor groups that only show a blank tab bar.
  for (const group of [...api.groups]) {
    if (group.panels.length === 0 && isEditorGroup(group)) {
      try {
        api.removeGroup(group);
      } catch {
        // Ignore if Dockview keeps the last group pinned.
      }
    }
  }

  const groupById = new Map<string, DockviewGroup>();
  for (const group of api.groups) {
    groupById.set(group.id, group);
  }

  let serialized: SerializedDockview | null = null;
  try {
    serialized = api.toJSON();
  } catch {
    serialized = null;
  }

  const root = serialized?.grid?.root as SerializedGridNode | undefined;
  const gridWidth = api.width || serialized?.grid?.width || 0;
  const gridHeight = api.height || serialized?.grid?.height || 0;
  const rootAxis: 'horizontal' | 'vertical' =
    serialized?.grid?.orientation === Orientation.VERTICAL
      ? 'vertical'
      : 'horizontal';

  if (root && root.type === 'branch') {
    arrangeBranch(
      root,
      rootAxis,
      { width: gridWidth, height: gridHeight },
      gridWidth,
      groupById,
      true
    );
  } else {
    // Fallback when serialized grid root is unavailable: balance visible columns.
    const liveVisible = api.groups.filter((group) => group.api.isVisible);
    const totalWidth =
      gridWidth || liveVisible.reduce((sum, group) => sum + group.api.width, 0);
    if (liveVisible.length > 1 && totalWidth > 0) {
      const hasEditor = liveVisible.some((group) => isEditorGroup(group));
      const fixed = new Map<DockviewGroup, number>();
      let reserved = 0;
      const flex: DockviewGroup[] = [];
      for (const group of liveVisible) {
        if (isLeftGroup(group) && !isRightShellNavGroup(group)) {
          const width = defaultPrimaryDockWidth(totalWidth);
          fixed.set(group, width);
          reserved += width;
        } else if (isLeftGroup(group)) {
          fixed.set(group, SECONDARY_DOCK_WIDTH);
          reserved += SECONDARY_DOCK_WIDTH;
        } else if (isSessionGroup(group) && hasEditor) {
          const width = defaultSessionPanelWidth(
            totalWidth,
            MIN_RIGHT_PANEL_WIDTH
          );
          fixed.set(group, width);
          reserved += width;
        } else {
          flex.push(group);
        }
      }
      const flexWidth =
        flex.length > 0
          ? Math.round(
              Math.max(
                flex.length * MIN_FLEX_COLUMN_WIDTH,
                totalWidth - reserved
              ) / flex.length
            )
          : 0;
      settleDockviewGroupWidths(
        liveVisible.map((group) => ({
          group,
          width: fixed.get(group) ?? flexWidth,
        }))
      );
    }
  }

  try {
    useLayoutStore.getState().setSerializedLayout(api.toJSON());
  } catch {
    // Ignore serialization failures on minimal test doubles.
  }

  return true;
}
