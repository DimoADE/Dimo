import { describe, expect, it, vi } from 'vitest';
import { Orientation } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';
import { GROUP_IDS, PANEL_IDS } from '@/stores/useLayoutStore';
import { DEFAULT_SESSION_PANEL_WIDTH } from '@/utils/dockviewStartupSizing';
import { autoArrangeDockviewLayout } from './dockviewAutoArrange';

interface MockGroup {
  id: string;
  panels: Array<{ id: string }>;
  api: {
    width: number;
    height: number;
    isVisible: boolean;
    setSize: ReturnType<typeof vi.fn>;
  };
}

function makeGroup(
  id: string,
  width: number,
  height: number,
  panelIds: string[],
  isVisible = true
): MockGroup {
  const group: MockGroup = {
    id,
    panels: panelIds.map((panelId) => ({ id: panelId })),
    api: {
      width,
      height,
      isVisible,
      setSize: vi.fn((size: { width?: number; height?: number }) => {
        if (typeof size.width === 'number') group.api.width = size.width;
        if (typeof size.height === 'number') group.api.height = size.height;
      }),
    },
  };
  return group;
}

describe('autoArrangeDockviewLayout', () => {
  it('balances split editor columns and restores default dock/session widths without unmounting panels', () => {
    const left = makeGroup(GROUP_IDS.LEFT, 480, 900, [PANEL_IDS.FILE_TREE]);
    const editorA = makeGroup('group-editor-1', 180, 900, ['file-a']);
    const editorB = makeGroup('group-editor-2', 740, 900, ['plugin-browser-1']);
    const right = makeGroup(GROUP_IDS.RIGHT, 200, 900, [PANEL_IDS.AI_CHAT]);
    const fromJSON = vi.fn();

    const api = {
      width: 1600,
      height: 900,
      groups: [left, editorA, editorB, right],
      removeGroup: vi.fn(),
      fromJSON,
      toJSON: () => ({
        grid: {
          orientation: Orientation.HORIZONTAL,
          width: 1600,
          height: 900,
          root: {
            type: 'branch',
            data: [
              { type: 'leaf', data: { id: left.id } },
              { type: 'leaf', data: { id: editorA.id } },
              { type: 'leaf', data: { id: editorB.id } },
              { type: 'leaf', data: { id: right.id } },
            ],
          },
        },
        panels: {},
      }),
    } as unknown as DockviewApi;

    expect(autoArrangeDockviewLayout(api)).toBe(true);
    expect(fromJSON).not.toHaveBeenCalled();

    expect(left.api.width).toBe(200);
    expect(right.api.width).toBe(DEFAULT_SESSION_PANEL_WIDTH);
    // Remaining 1600 - 200 - 434 = 966 split equally across 2 editors = 483 each
    expect(editorA.api.width).toBe(483);
    expect(editorB.api.width).toBe(483);
  });

  it('balances vertical splits, resets bottom terminal shelf height, and removes empty editor groups', () => {
    const editorTop = makeGroup('group-editor-1', 1000, 200, ['file-a']);
    const bottom = makeGroup(GROUP_IDS.BOTTOM, 1000, 600, [PANEL_IDS.TERMINAL]);
    const emptyEditor = makeGroup('group-editor-empty', 200, 800, []);
    const groups = [editorTop, bottom, emptyEditor];

    const api = {
      width: 1000,
      height: 800,
      groups,
      removeGroup: vi.fn((target: MockGroup) => {
        const idx = groups.indexOf(target);
        if (idx !== -1) groups.splice(idx, 1);
      }),
      toJSON: () => ({
        grid: {
          orientation: Orientation.HORIZONTAL,
          width: 1000,
          height: 800,
          root: {
            type: 'branch',
            data: [
              {
                type: 'branch',
                data: [
                  { type: 'leaf', data: { id: editorTop.id } },
                  { type: 'leaf', data: { id: bottom.id } },
                ],
              },
            ],
          },
        },
        panels: {},
      }),
    } as unknown as DockviewApi;

    expect(autoArrangeDockviewLayout(api)).toBe(true);
    expect(api.removeGroup).toHaveBeenCalledWith(emptyEditor);
    expect(bottom.api.height).toBe(DEFAULT_TERMINAL_PANEL_HEIGHT);
    expect(editorTop.api.height).toBe(800 - DEFAULT_TERMINAL_PANEL_HEIGHT);
  });
});
