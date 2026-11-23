import { contributionMetadata } from '@/hooks/usePluginHostContributions';
import type { PluginContributionCatalogItem } from '@/lib/api/plugins';
import { pluginSurfaceId } from '@/lib/hostSurfaceIds';
import { editorTerminalPanelId } from '@/lib/workspaceTerminalTabs';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { generateTerminalTabId } from '@/stores/useTerminalStore';
import type { OpenCanvasPanelRequest } from './canvasWorkspaceBridge';

let nextCanvasPluginInstanceSeq = 0;

function nextPluginInstanceSuffix(): string {
  nextCanvasPluginInstanceSeq += 1;
  return `${Date.now().toString(36)}-${nextCanvasPluginInstanceSeq.toString(36)}`;
}

export function buildCanvasTerminalPanelRequest(options: {
  shell: string;
  shells: ReadonlyArray<{ value: string; label: string }>;
  fallbackTitle: string;
  cwd?: string | null;
  parentNodeId?: string | null;
}): OpenCanvasPanelRequest {
  const tabId = generateTerminalTabId();
  const shellInfo = options.shells.find((item) => item.value === options.shell);
  const title = shellInfo?.label || options.shell || options.fallbackTitle;
  return {
    id: editorTerminalPanelId(tabId),
    component: PANEL_IDS.TERMINAL,
    title,
    params: {
      surface: 'editor',
      tabId,
      shell: options.shell,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
    expanded: true,
    ...(options.parentNodeId !== undefined
      ? { parentNodeId: options.parentNodeId }
      : {}),
  };
}

export function buildCanvasPluginPanelRequest(
  item: PluginContributionCatalogItem,
  options?: {
    forceMultiInstance?: boolean;
    fallbackIcon?: string | null;
    parentNodeId?: string | null;
  }
): OpenCanvasPanelRequest {
  const metadata = contributionMetadata(item);
  const icon =
    typeof metadata.icon === 'string'
      ? metadata.icon
      : (options?.fallbackIcon ?? null);
  const baseId = pluginSurfaceId(item.pluginId, item.id);
  const multiInstance =
    options?.forceMultiInstance === true || metadata.multiInstance === true;
  const id = multiInstance ? `${baseId}:${nextPluginInstanceSuffix()}` : baseId;
  return {
    id,
    component: 'plugin-panel',
    title: item.label,
    params: {
      pluginId: item.pluginId,
      contributionId: item.id,
      icon,
    },
    expanded: true,
    ...(options?.parentNodeId !== undefined
      ? { parentNodeId: options.parentNodeId }
      : {}),
  };
}
