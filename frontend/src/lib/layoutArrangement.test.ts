import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_KANBAN_ARRANGEMENT,
  DEFAULT_LAYOUT_ARRANGEMENT,
  arrangementsEqual,
  getLayoutArrangement,
  isDefaultArrangement,
  kanbanSessionResizeHandleSide,
  kanbanSlotOfZone,
  resetKanbanArrangement,
  setKanbanArrangement,
  slotOfZone,
  type LayoutArrangement,
} from './layoutArrangement';

describe('layoutArrangement', () => {
  beforeEach(() => {
    localStorage.removeItem('dimo:layout-arrangement');
    resetKanbanArrangement();
  });

  it('defaults to A/B/C/D in left/center/right/bottom', () => {
    expect(getLayoutArrangement()).toEqual({
      left: 'dock',
      center: 'workspace',
      right: 'session',
      bottom: 'terminal',
    });
    expect(isDefaultArrangement(getLayoutArrangement())).toBe(true);
  });

  it('reads back valid persisted workspace arrangements', () => {
    const next: LayoutArrangement = {
      left: 'terminal',
      center: 'workspace',
      right: 'session',
      bottom: 'dock',
    };
    localStorage.setItem('dimo:layout-arrangement', JSON.stringify(next));

    expect(getLayoutArrangement()).toEqual(next);
    expect(arrangementsEqual(getLayoutArrangement(), next)).toBe(true);
    expect(isDefaultArrangement(getLayoutArrangement())).toBe(false);
  });

  it('ignores invalid persisted values', () => {
    localStorage.setItem(
      'dimo:layout-arrangement',
      JSON.stringify({ left: 'dock', center: 'dock', right: 'session' })
    );

    expect(getLayoutArrangement()).toEqual(DEFAULT_LAYOUT_ARRANGEMENT);
  });

  it('finds the slot of a zone', () => {
    const arrangement: LayoutArrangement = {
      left: 'dock',
      center: 'workspace',
      right: 'terminal',
      bottom: 'session',
    };

    expect(slotOfZone(arrangement, 'session')).toBe('bottom');
    expect(slotOfZone(arrangement, 'terminal')).toBe('right');
    expect(slotOfZone(arrangement, 'workspace')).toBe('center');
  });

  describe('kanban arrangement', () => {
    it('persists a swapped kanban arrangement and reports zone slots', () => {
      const swapped = {
        left: 'list' as const,
        center: 'session' as const,
        right: 'monitor' as const,
      };
      setKanbanArrangement(swapped);

      expect(kanbanSlotOfZone(swapped, 'session')).toBe('center');
      expect(
        JSON.parse(
          localStorage.getItem('dimo:kanban-layout-arrangement') ?? '{}'
        )
      ).toEqual(swapped);
      expect(getLayoutArrangement()).toEqual(DEFAULT_LAYOUT_ARRANGEMENT);
    });

    it('places the session resize handle on the edge facing the monitor', () => {
      expect(kanbanSessionResizeHandleSide(DEFAULT_KANBAN_ARRANGEMENT)).toBe(
        'left'
      );
      expect(
        kanbanSessionResizeHandleSide({
          left: 'list',
          center: 'session',
          right: 'monitor',
        })
      ).toBe('right');
      expect(
        kanbanSessionResizeHandleSide({
          left: 'session',
          center: 'monitor',
          right: 'list',
        })
      ).toBe('right');
      expect(
        kanbanSessionResizeHandleSide({
          left: 'monitor',
          center: 'session',
          right: 'list',
        })
      ).toBe('left');
    });
  });
});
