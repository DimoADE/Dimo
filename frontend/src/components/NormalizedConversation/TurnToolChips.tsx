import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2 } from 'lucide-react';
import FileIcon from '@/components/FileIcon';
import { cn } from '@/lib/utils';
import { useExpandable } from '@/stores/useExpandableStore';
import type { TurnToolDiffChip } from './turnToolDiffChips';

export type TurnToolIconKind =
  | 'think'
  | 'write'
  | 'run'
  | 'read'
  | 'search'
  | 'web'
  | 'agent'
  | 'tool'
  | 'mixed';

export type TurnToolStatus = 'pending' | 'running' | 'complete' | 'error';

export type TurnToolChipItem = {
  key: string;
  index: number;
  icon: TurnToolIconKind;
  label: string;
  targetText?: string;
  chip?: ReactNode;
  monoChip?: boolean;
  additions?: number;
  deletions?: number;
  status: TurnToolStatus;
  errorMessage?: string;
  resultDetail?: ReactNode;
  isDetailExpanded?: boolean;
  onDetailExpandedChange?: (expanded: boolean) => void;
};

export type TurnToolBatchLiveHeader = {
  icon: TurnToolIconKind;
  label: string;
  targetText?: string;
  monoTarget?: boolean;
  status: TurnToolStatus;
};

type ScrollFadeState = 'none' | 'top' | 'bottom' | 'both';

const INITIAL_VISIBLE_DIFF_CHIPS = 5;
const PREVIEW_CARD_WIDTH = 304;
const PREVIEW_VIEWPORT_MARGIN = 8;
const PREVIEW_ANCHOR_GAP = 6;
const FOLLOW_BOTTOM_THRESHOLD_PX = 4;
const TOGGLE_ANCHOR_TTL_MS = 250;

const CHEVRON_RIGHT_ICON = (
  <path
    d="M9 6l6 6-6 6"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);

const TOOL_CHIP_ICONS: Record<TurnToolIconKind, ReactNode> = {
  think: (
    <path
      d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"
      fill="currentColor"
    />
  ),
  write: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.4 2.6a2.1 2.1 0 1 1 3 3L12 15l-4 1 1-4z" />
    </g>
  ),
  run: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 17l6-5-6-5" />
      <path d="M12 19h8" />
    </g>
  ),
  read: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.75" />
    </g>
  ),
  search: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.8-3.8" />
    </g>
  ),
  web: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8" />
      <path d="M12 3a14.5 14.5 0 0 1 0 18 14.5 14.5 0 0 1 0-18z" />
    </g>
  ),
  agent: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 13h.01M15 13h.01" />
    </g>
  ),
  tool: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-5.6 5.6a1.8 1.8 0 0 0 2.6 2.6l5.6-5.6a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.2-.4-.4-2.2z" />
    </g>
  ),
  mixed: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m15 12-8.5 8.5c-.83.83-2.17.83-3 0 0 0 0 0 0 0a2.12 2.12 0 0 1 0-3L12 9" />
      <path d="M17.64 15 22 10.64" />
      <path d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91" />
    </g>
  ),
};

export function TurnToolChipRow({
  icon,
  label,
  chip,
  monoChip = false,
  additions,
  deletions,
  showInlineDiffCounts = false,
  status = 'complete',
  errorMessage,
  detail,
  expanded = false,
  onExpandedChange,
  ariaControls,
}: {
  icon: TurnToolIconKind;
  label: string;
  chip?: ReactNode;
  monoChip?: boolean;
  additions?: number;
  deletions?: number;
  showInlineDiffCounts?: boolean;
  status?: TurnToolStatus;
  errorMessage?: string;
  detail?: ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  ariaControls?: string;
}) {
  const generatedDetailId = useId();
  const detailId = ariaControls ?? generatedDetailId;
  const isExpandable = Boolean(onExpandedChange && (detail || ariaControls));
  const isRunning = status === 'running' || status === 'pending';
  const isError = status === 'error';

  const handleToggle = () => {
    if (!isExpandable || !onExpandedChange) return;
    onExpandedChange(!expanded);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isExpandable) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleToggle();
    }
  };

  return (
    <div
      className="conv-tool-chip-item"
      data-testid="turn-tool-chip-item"
      data-tool-status={status}
    >
      <div
        role={isExpandable ? 'button' : undefined}
        tabIndex={isExpandable ? 0 : undefined}
        aria-expanded={isExpandable ? expanded : undefined}
        aria-controls={isExpandable && expanded ? detailId : undefined}
        title={isError && errorMessage ? errorMessage : undefined}
        data-testid="turn-tool-chip-row"
        className={cn(
          'conv-tool-chip-row',
          isExpandable && 'is-expandable',
          expanded && 'is-expanded',
          isError && 'is-error',
          isRunning && 'is-running'
        )}
        onClick={isExpandable ? handleToggle : undefined}
        onKeyDown={isExpandable ? handleKeyDown : undefined}
      >
        {isError ? <span className="sr-only">Error: </span> : null}
        <span className="conv-tool-chip-icon-slot" aria-hidden="true">
          {isRunning ? (
            <Loader2
              className="conv-tool-chip-kind-icon conv-tool-chip-spinner"
              aria-hidden="true"
            />
          ) : (
            <svg
              viewBox="0 0 24 24"
              className="conv-tool-chip-kind-icon"
              aria-hidden="true"
              focusable="false"
            >
              {TOOL_CHIP_ICONS[icon]}
            </svg>
          )}
        </span>

        <span className="conv-tool-chip-main">
          {label ? <span className="conv-tool-chip-label">{label}</span> : null}

          {chip ? (
            <span className={cn('conv-tool-chip-pill', monoChip && 'is-mono')}>
              {typeof chip === 'string' ? (
                <span className="conv-tool-chip-pill-text">{chip}</span>
              ) : (
                chip
              )}
            </span>
          ) : null}
        </span>

        <span className="conv-tool-chip-trailing">
          {showInlineDiffCounts && additions ? (
            <span className="conv-tool-diff-add tabular-nums">
              +{additions}
            </span>
          ) : null}
          {showInlineDiffCounts && deletions ? (
            <span className="conv-tool-diff-del tabular-nums">
              -{deletions}
            </span>
          ) : null}

          {isExpandable ? (
            <span className="conv-tool-chip-chevron-slot" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                className={cn(
                  'conv-tool-chip-chevron',
                  expanded && 'is-expanded'
                )}
                aria-hidden="true"
                focusable="false"
              >
                {CHEVRON_RIGHT_ICON}
              </svg>
            </span>
          ) : null}
        </span>
      </div>

      {isExpandable && expanded && detail ? (
        <div id={detailId} className="conv-tool-chip-detail">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

type DiffHoverState = {
  diff: TurnToolDiffChip;
  rect: DOMRect;
};

export function TurnToolDiffChipsBar({
  diffs,
  onOpenDiff,
}: {
  diffs: readonly TurnToolDiffChip[];
  onOpenDiff?: (diff: TurnToolDiffChip) => void;
}) {
  const { t } = useTranslation('conversation');
  const [showAll, setShowAll] = useState(false);
  const [hover, setHover] = useState<DiffHoverState | null>(null);

  useEffect(() => {
    if (!hover) return undefined;
    const dismiss = () => setHover(null);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setHover(null);
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [hover]);

  if (diffs.length === 0) return null;

  const visibleDiffs =
    showAll || diffs.length <= INITIAL_VISIBLE_DIFF_CHIPS
      ? diffs
      : diffs.slice(0, INITIAL_VISIBLE_DIFF_CHIPS);
  const hiddenCount = diffs.length - visibleDiffs.length;

  const openPreview = (diff: TurnToolDiffChip, element: HTMLButtonElement) => {
    if (diff.previewLines.length === 0) return;
    setHover({ diff, rect: element.getBoundingClientRect() });
  };

  const computePortalStyle = (rect: DOMRect) => {
    const viewportW =
      typeof window !== 'undefined' ? window.innerWidth : PREVIEW_CARD_WIDTH;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const maxLeft = Math.max(
      PREVIEW_VIEWPORT_MARGIN,
      viewportW - PREVIEW_CARD_WIDTH - PREVIEW_VIEWPORT_MARGIN
    );
    const left = Math.min(
      Math.max(PREVIEW_VIEWPORT_MARGIN, rect.left),
      maxLeft
    );
    const spaceBelow = viewportH - rect.bottom;
    const placeAbove = spaceBelow < 200 && rect.top > spaceBelow;
    return placeAbove
      ? {
          left,
          bottom: viewportH - rect.top + PREVIEW_ANCHOR_GAP,
          width: `min(${PREVIEW_CARD_WIDTH}px, calc(100vw - ${PREVIEW_VIEWPORT_MARGIN * 2}px))`,
        }
      : {
          left,
          top: rect.bottom + PREVIEW_ANCHOR_GAP,
          width: `min(${PREVIEW_CARD_WIDTH}px, calc(100vw - ${PREVIEW_VIEWPORT_MARGIN * 2}px))`,
        };
  };

  return (
    <>
      <div className="conv-tool-diff-chips" data-testid="turn-tool-diff-chips">
        {visibleDiffs.map((diff) => (
          <button
            key={diff.key}
            type="button"
            data-diffchip=""
            className="conv-tool-diff-chip"
            title={diff.displayPath}
            aria-label={t('toolChips.showDiff', { file: diff.displayPath })}
            onClick={() => onOpenDiff?.(diff)}
            onMouseEnter={(event: MouseEvent<HTMLButtonElement>) =>
              openPreview(diff, event.currentTarget)
            }
            onMouseLeave={() => setHover(null)}
            onFocus={(event: FocusEvent<HTMLButtonElement>) =>
              openPreview(diff, event.currentTarget)
            }
            onBlur={() => setHover(null)}
          >
            <FileIcon
              filePath={diff.displayPath}
              className="conv-tool-diff-file-icon"
            />
            <span className="conv-tool-diff-name">{diff.fileName}</span>
            {diff.additions > 0 || diff.deletions === 0 ? (
              <span className="conv-tool-diff-add tabular-nums">
                +{diff.additions}
              </span>
            ) : null}
            {diff.deletions > 0 ? (
              <span className="conv-tool-diff-del tabular-nums">
                -{diff.deletions}
              </span>
            ) : null}
          </button>
        ))}

        {hiddenCount > 0 ? (
          <button
            type="button"
            className="conv-tool-diff-chip conv-tool-diff-more tabular-nums"
            onClick={() => setShowAll(true)}
          >
            {t('toolChips.more', { count: hiddenCount })}
          </button>
        ) : null}
      </div>

      {hover && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="tooltip"
              data-testid="turn-tool-diff-preview"
              className="conv-tool-diff-preview"
              style={computePortalStyle(hover.rect)}
            >
              <div className="conv-tool-diff-preview-header">
                <span className="conv-tool-diff-preview-path">
                  {hover.diff.displayPath}
                </span>
                <span className="conv-tool-diff-preview-counts tabular-nums">
                  {hover.diff.additions > 0 || hover.diff.deletions === 0 ? (
                    <span className="conv-tool-diff-add">
                      +{hover.diff.additions}
                    </span>
                  ) : null}
                  {hover.diff.deletions > 0 ? (
                    <span className="conv-tool-diff-del">
                      -{hover.diff.deletions}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="conv-tool-diff-preview-body">
                {hover.diff.previewLines.map((line, lineIndex) => (
                  <div
                    key={lineIndex}
                    className={cn(
                      'conv-tool-diff-preview-line',
                      line.tone === 'add' && 'is-add',
                      line.tone === 'del' && 'is-del'
                    )}
                  >
                    <span
                      className="conv-tool-diff-preview-sign"
                      aria-hidden="true"
                    >
                      {line.tone === 'add'
                        ? '+'
                        : line.tone === 'del'
                          ? '−'
                          : ' '}
                    </span>
                    <span className="conv-tool-diff-preview-code">
                      {line.text || '\u00a0'}
                    </span>
                  </div>
                ))}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function measureExpandedDetailsHeight(viewport: HTMLElement): number {
  let total = 0;
  const details = viewport.querySelectorAll<HTMLElement>(
    '.conv-tool-chip-detail'
  );
  for (const detail of details) {
    const style =
      typeof window !== 'undefined' ? window.getComputedStyle(detail) : null;
    const marginTop = style ? Number.parseFloat(style.marginTop) || 0 : 0;
    const marginBottom = style ? Number.parseFloat(style.marginBottom) || 0 : 0;
    total += detail.offsetHeight + marginTop + marginBottom;
  }
  return Math.round(total);
}

type PendingToggleAnchor = {
  scrollTop: number;
  wasExpanded: boolean;
  capturedAt: number;
};

export function TurnToolChipsBatch({
  expansionKey,
  label,
  liveHeader = null,
  itemCount = 0,
  isStreaming = false,
  isActive = false,
  timestampLabel = null,
  diffs,
  onOpenDiff,
  children,
}: {
  expansionKey: string;
  label: string;
  icon?: TurnToolIconKind;
  liveHeader?: TurnToolBatchLiveHeader | null;
  itemCount?: number;
  isStreaming?: boolean;
  isActive?: boolean;
  timestampLabel?: string | null;
  diffs?: readonly TurnToolDiffChip[];
  onOpenDiff?: (diff: TurnToolDiffChip) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('conversation');
  const id = useId();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const prevItemCountRef = useRef(itemCount);
  const lastExpandedDetailHeightRef = useRef(0);
  const lastExpandedDetailCountRef = useRef(0);
  const lastStableScrollTopRef = useRef(0);
  const pendingToggleAnchorRef = useRef<PendingToggleAnchor | null>(null);
  const [expanded, toggle] = useExpandable(expansionKey, false);
  const [scrollFade, setScrollFade] = useState<ScrollFadeState>('none');

  const updateScrollFade = useCallback((viewport: HTMLElement) => {
    const distanceFromBottom =
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    wasAtBottomRef.current = distanceFromBottom <= FOLLOW_BOTTOM_THRESHOLD_PX;
    const top = viewport.scrollTop > 1;
    const bottom = distanceFromBottom > 1;
    const nextFade: ScrollFadeState =
      top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : 'none';
    setScrollFade((previous) => (previous === nextFade ? previous : nextFade));
  }, []);

  const syncViewportMetrics = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const existingAnchor = pendingToggleAnchorRef.current;
    if (
      existingAnchor &&
      Date.now() - existingAnchor.capturedAt > TOGGLE_ANCHOR_TTL_MS
    ) {
      pendingToggleAnchorRef.current = null;
    }

    const nextExpandedCount = viewport.querySelectorAll(
      '.conv-tool-chip-detail'
    ).length;
    const nextExpandedHeight = measureExpandedDetailsHeight(viewport);
    const prevExpandedHeight = lastExpandedDetailHeightRef.current;
    const prevExpandedCount = lastExpandedDetailCountRef.current;

    // Sync the dynamic height delta directly to the DOM before measuring/restoring
    // scrollTop so collapsing a detail never shrinks scrollHeight while max-height
    // is still inflated by a stale React state frame.
    if (nextExpandedHeight > 0) {
      viewport.style.setProperty(
        '--conv-batch-expanded-extra',
        `${nextExpandedHeight}px`
      );
    } else {
      viewport.style.removeProperty('--conv-batch-expanded-extra');
    }

    const pendingAnchor = pendingToggleAnchorRef.current;
    const detailsCollapsed =
      nextExpandedHeight < prevExpandedHeight ||
      nextExpandedCount < prevExpandedCount;
    const detailsExpanded =
      nextExpandedHeight > prevExpandedHeight ||
      nextExpandedCount > prevExpandedCount;

    if (detailsCollapsed || (pendingAnchor && detailsExpanded)) {
      const anchorScrollTop =
        pendingAnchor?.scrollTop ?? lastStableScrollTopRef.current;
      const maxScrollTop = Math.max(
        0,
        viewport.scrollHeight - viewport.clientHeight
      );
      const restoredScrollTop = Math.min(anchorScrollTop, maxScrollTop);
      if (Math.abs(viewport.scrollTop - restoredScrollTop) > 0.5) {
        viewport.scrollTop = restoredScrollTop;
      }
      lastStableScrollTopRef.current = viewport.scrollTop;
      pendingToggleAnchorRef.current = null;
    } else if (!pendingAnchor) {
      lastStableScrollTopRef.current = viewport.scrollTop;
    }

    lastExpandedDetailHeightRef.current = nextExpandedHeight;
    lastExpandedDetailCountRef.current = nextExpandedCount;
    updateScrollFade(viewport);
  }, [updateScrollFade]);

  const captureToggleAnchor = useCallback((target: EventTarget | null) => {
    const viewport = viewportRef.current;
    if (!viewport || !(target instanceof Element)) return;
    const nestedInteractive = target.closest(
      'a, button:not(.conv-tool-chip-row)'
    );
    if (nestedInteractive && viewport.contains(nestedInteractive)) return;
    const row = target.closest('.conv-tool-chip-row.is-expandable');
    if (!row || !viewport.contains(row)) return;
    pendingToggleAnchorRef.current = {
      scrollTop: viewport.scrollTop,
      wasExpanded: row.classList.contains('is-expanded'),
      capturedAt: Date.now(),
    };
  }, []);

  useLayoutEffect(() => {
    if (!expanded) {
      setScrollFade('none');
      wasAtBottomRef.current = true;
      prevItemCountRef.current = itemCount;
      lastExpandedDetailHeightRef.current = 0;
      lastExpandedDetailCountRef.current = 0;
      lastStableScrollTopRef.current = 0;
      pendingToggleAnchorRef.current = null;
      return undefined;
    }
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport) return undefined;

    if (
      isStreaming &&
      itemCount > prevItemCountRef.current &&
      wasAtBottomRef.current
    ) {
      viewport.scrollTop = viewport.scrollHeight;
    }
    prevItemCountRef.current = itemCount;
    syncViewportMetrics();

    const resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(syncViewportMetrics)
        : null;
    if (resizeObserver && typeof resizeObserver.observe === 'function') {
      resizeObserver.observe(viewport);
      if (content) resizeObserver.observe(content);
    }

    const mutationObserver =
      typeof MutationObserver === 'function' && content
        ? new MutationObserver(syncViewportMetrics)
        : null;
    if (mutationObserver && content) {
      mutationObserver.observe(content, { childList: true, subtree: true });
    }

    return () => {
      if (resizeObserver && typeof resizeObserver.disconnect === 'function') {
        resizeObserver.disconnect();
      }
      if (
        mutationObserver &&
        typeof mutationObserver.disconnect === 'function'
      ) {
        mutationObserver.disconnect();
      }
    };
  }, [expanded, isStreaming, itemCount, syncViewportMetrics]);

  const showLiveCollapsed = isStreaming && !expanded && liveHeader !== null;
  const headerIsRunning = showLiveCollapsed
    ? liveHeader.status === 'running' || liveHeader.status === 'pending'
    : isStreaming && isActive;
  const headerIsError = showLiveCollapsed && liveHeader.status === 'error';

  return (
    <div
      className="conv-activity-batch conv-tool-chips-batch"
      data-testid="turn-tool-chips-batch"
    >
      <button
        type="button"
        className={cn(
          'conv-activity-header conv-tool-chips-header',
          expanded && 'is-expanded',
          showLiveCollapsed && 'is-live',
          headerIsError && 'is-error'
        )}
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        onClick={() => toggle()}
      >
        <span className="conv-tool-chips-header-icon" aria-hidden="true">
          {headerIsRunning && !expanded ? (
            <Loader2
              className="conv-tool-chip-kind-icon conv-tool-chip-spinner"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="conv-tool-chips-disclosure-icon"
              data-testid="turn-tool-chips-disclosure"
              aria-hidden="true"
            />
          )}
        </span>

        {showLiveCollapsed ? (
          <span className="conv-tool-chips-header-label conv-tool-chips-live-label">
            {liveHeader.label ? (
              <span className="conv-tool-chip-label">{liveHeader.label}</span>
            ) : null}
            {liveHeader.targetText ? (
              <span
                className={cn(
                  'conv-tool-chips-live-target',
                  liveHeader.monoTarget && 'is-mono'
                )}
              >
                {liveHeader.targetText}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="conv-tool-chips-header-label tabular-nums">
            {label}
          </span>
        )}

        {showLiveCollapsed && itemCount > 1 ? (
          <span
            className="conv-tool-chips-live-count tabular-nums"
            aria-hidden="true"
          >
            {itemCount}
          </span>
        ) : timestampLabel ? (
          <time
            className="conv-tool-chips-timestamp tabular-nums"
            aria-hidden="true"
          >
            {timestampLabel}
          </time>
        ) : null}
      </button>

      {expanded ? (
        <div
          id={id}
          ref={viewportRef}
          role="region"
          tabIndex={0}
          aria-label={t('toolChips.activityList')}
          data-testid="turn-tool-chips-viewport"
          data-scroll-fade={scrollFade}
          data-tool-group-scroll=""
          data-overlay-scrollbar="off"
          className="conv-tool-chips-viewport"
          onClickCapture={(event) => captureToggleAnchor(event.target)}
          onKeyDownCapture={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              captureToggleAnchor(event.target);
            }
          }}
          onScroll={syncViewportMetrics}
        >
          <div ref={contentRef} className="conv-tool-chips-list">
            {children}
          </div>
        </div>
      ) : null}

      {diffs && diffs.length > 0 ? (
        <TurnToolDiffChipsBar diffs={diffs} onOpenDiff={onOpenDiff} />
      ) : null}
    </div>
  );
}
