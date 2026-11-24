/**
 * Three-stage Kanban panel view state management
 *
 * Order: board(Kanban-1) -> sessionHub(Kanban-2, default) -> usageDashboard(Kanban-3)
 *
 * - board: 四栏看板视图
 * - sessionHub: 会话列表+监控视图 (默认显示页)
 * - usageDashboard: 计量统计视图
 */

export type KanbanPanelView = 'board' | 'sessionHub' | 'usageDashboard';

/** Default view is sessionHub (middle panel) */
export const DEFAULT_KANBAN_VIEW: KanbanPanelView = 'sessionHub';
