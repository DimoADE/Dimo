import { describe, expect, it } from 'vitest';
import { DEFAULT_KANBAN_VIEW } from './kanbanPanelView';

describe('kanbanPanelView', () => {
  it('defaults to sessionHub', () => {
    expect(DEFAULT_KANBAN_VIEW).toBe('sessionHub');
  });
});
