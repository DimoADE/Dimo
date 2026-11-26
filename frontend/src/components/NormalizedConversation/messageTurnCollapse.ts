import { isAskQuestionTool } from '@/components/tasks/follow-up/agentQuestionModel';
import type { TurnRenderItem } from './messageTurnBlocks';

export type CollapsedTurnSegment = {
  kind: 'fold' | 'items';
  startIndex: number;
  items: TurnRenderItem[];
};

export function isAskQuestionTurnItem(item: TurnRenderItem): boolean {
  return (
    item.kind === 'tool' && item.use != null && isAskQuestionTool(item.use)
  );
}

export function isCollapsibleProcessItem(item: TurnRenderItem): boolean {
  if (isAskQuestionTurnItem(item)) return false;
  return item.kind !== 'markdown' || item.text.trim().length > 0;
}

export function collapseTurnSegments(
  items: TurnRenderItem[],
  options?: { isStreaming?: boolean }
): CollapsedTurnSegment[] {
  if (items.length === 0) return [];
  if (!items.some(isAskQuestionTurnItem)) {
    return collapseSlice(items, 0, Boolean(options?.isStreaming));
  }

  const segments: CollapsedTurnSegment[] = [];
  let cursor = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (!isAskQuestionTurnItem(item)) continue;
    if (index > cursor) {
      segments.push(
        ...collapseSlice(items.slice(cursor, index), cursor, false)
      );
    }
    segments.push({
      kind: 'items',
      startIndex: index,
      items: [item],
    });
    cursor = index + 1;
  }
  if (cursor < items.length) {
    segments.push(
      ...collapseSlice(
        items.slice(cursor),
        cursor,
        Boolean(options?.isStreaming)
      )
    );
  }
  return segments;
}

function collapseSlice(
  items: TurnRenderItem[],
  offset: number,
  isStreaming: boolean
): CollapsedTurnSegment[] {
  if (items.length === 0) return [];
  const lastMarkdownIndex = items.reduce(
    (latest, item, index) => (item.kind === 'markdown' ? index : latest),
    -1
  );
  if (lastMarkdownIndex < 0) {
    return isStreaming
      ? [{ kind: 'items', startIndex: offset, items: [...items] }]
      : [{ kind: 'fold', startIndex: offset, items: [...items] }];
  }
  return foldBeforeProse(items, lastMarkdownIndex, offset);
}

/** One prelude of everything before the latest prose, then that prose onward. */
function foldBeforeProse(
  items: TurnRenderItem[],
  lastMarkdownIndex: number,
  offset = 0
): CollapsedTurnSegment[] {
  const visible = items[lastMarkdownIndex];
  const visibleText = visible?.kind === 'markdown' ? visible.text.trim() : '';
  const prelude = items.slice(0, lastMarkdownIndex).filter((item) => {
    if (item.kind !== 'markdown' || visibleText.length === 0) return true;
    return item.text.trim() !== visibleText;
  });
  const segments: CollapsedTurnSegment[] = [];
  if (prelude.length > 0) {
    const preludeStart = items.indexOf(prelude[0]);
    segments.push({
      kind: prelude.some(isCollapsibleProcessItem) ? 'fold' : 'items',
      startIndex: offset + (preludeStart < 0 ? 0 : preludeStart),
      items: prelude,
    });
  }
  segments.push({
    kind: 'items',
    startIndex: offset + lastMarkdownIndex,
    items: items.slice(lastMarkdownIndex),
  });
  return segments;
}
