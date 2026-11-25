import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Check, ChevronDown, Copy } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';

type TableCopyFormat = 'markdown' | 'csv' | 'tsv';

const TABLE_SCROLLBAR_MIN_THUMB_PX = 36;

export type TableScrollbarMetrics = {
  thumbWidth: number;
  offset: number;
  travel: number;
  overflow: number;
  percent: number;
};

export function computeTableScrollbarMetrics(input: {
  clientWidth: number;
  scrollWidth: number;
  scrollLeft: number;
  trackWidth: number;
  minThumb?: number;
}): TableScrollbarMetrics | null {
  const overflow = input.scrollWidth - input.clientWidth;
  if (overflow <= 1 || input.trackWidth <= 1 || input.clientWidth <= 0) {
    return null;
  }
  const minThumb = input.minThumb ?? TABLE_SCROLLBAR_MIN_THUMB_PX;
  const thumbWidth = Math.min(
    input.trackWidth,
    Math.max(minThumb, (input.clientWidth / input.scrollWidth) * input.trackWidth)
  );
  const travel = Math.max(0, input.trackWidth - thumbWidth);
  const clampedScrollLeft = Math.min(overflow, Math.max(0, input.scrollLeft));
  const offset = travel > 0 ? (clampedScrollLeft / overflow) * travel : 0;
  const percent = Math.round((clampedScrollLeft / overflow) * 100);
  return { thumbWidth, offset, travel, overflow, percent };
}

function extractTableMatrix(table: HTMLTableElement): string[][] {
  const rows = Array.from(table.querySelectorAll('tr'));
  return rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) =>
      (cell.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
  );
}

export function formatMatrixAsMarkdown(matrix: string[][]): string {
  if (matrix.length === 0) return '';
  const colCount = Math.max(...matrix.map((row) => row.length), 0);
  if (colCount === 0) return '';

  const escapeCell = (value: string) => value.replace(/\|/g, '\\|');
  const padRow = (row: string[]) =>
    Array.from({ length: colCount }, (_, idx) => escapeCell(row[idx] ?? ''));

  const header = `| ${padRow(matrix[0] ?? []).join(' | ')} |`;
  const separator = `| ${Array(colCount).fill('---').join(' | ')} |`;
  const body = matrix
    .slice(1)
    .map((row) => `| ${padRow(row).join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function formatMatrixAsDelimited(
  matrix: string[][],
  delimiter: ',' | '\t'
): string {
  return matrix
    .map((row) =>
      row
        .map((cell) =>
          delimiter === ',' ? escapeCsvCell(cell) : cell.replace(/[\t\r\n]+/g, ' ')
        )
        .join(delimiter)
    )
    .join('\n');
}

export function MarkdownTable({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'table'>) {
  const scrollRegionId = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [copied, triggerCopied] = useTemporaryFlag(1400);
  const [copiedFormat, setCopiedFormat] = useState<TableCopyFormat>('markdown');
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const syncScrollbar = useCallback(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const trackEl = trackRef.current;
    const trackWidth = trackEl?.clientWidth || scrollEl.clientWidth;
    const metrics = computeTableScrollbarMetrics({
      clientWidth: scrollEl.clientWidth,
      scrollWidth: scrollEl.scrollWidth,
      scrollLeft: scrollEl.scrollLeft,
      trackWidth,
    });
    const nextOverflow = metrics !== null;
    setHasHorizontalOverflow((prev) =>
      prev === nextOverflow ? prev : nextOverflow
    );
    if (!metrics) return;
    const thumbEl = thumbRef.current;
    if (thumbEl) {
      thumbEl.style.width = `${metrics.thumbWidth}px`;
      thumbEl.style.transform = `translateX(${metrics.offset}px)`;
    }
    if (trackEl) {
      trackEl.setAttribute('aria-valuenow', String(metrics.percent));
    }
  }, []);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    const tableEl = tableRef.current;
    if (!scrollEl) return;

    syncScrollbar();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncScrollbar, { passive: true });
      return () => window.removeEventListener('resize', syncScrollbar);
    }

    const observer = new ResizeObserver(syncScrollbar);
    observer.observe(scrollEl);
    if (tableEl) observer.observe(tableEl);
    return () => observer.disconnect();
  }, [syncScrollbar]);

  useLayoutEffect(() => {
    syncScrollbar();
  }, [children, hasHorizontalOverflow, syncScrollbar]);

  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const scrollEl = scrollRef.current;
      const trackEl = trackRef.current;
      if (!scrollEl || !trackEl) return;
      if (
        thumbRef.current &&
        event.target instanceof Node &&
        thumbRef.current.contains(event.target)
      ) {
        return;
      }

      const trackRect = trackEl.getBoundingClientRect();
      const metrics = computeTableScrollbarMetrics({
        clientWidth: scrollEl.clientWidth,
        scrollWidth: scrollEl.scrollWidth,
        scrollLeft: scrollEl.scrollLeft,
        trackWidth: trackRect.width || trackEl.clientWidth || scrollEl.clientWidth,
      });
      if (!metrics || metrics.travel <= 0) return;

      const clickX = event.clientX - trackRect.left;
      const targetOffset = Math.min(
        metrics.travel,
        Math.max(0, clickX - metrics.thumbWidth / 2)
      );
      scrollEl.scrollLeft = (targetOffset / metrics.travel) * metrics.overflow;
      syncScrollbar();
      event.preventDefault();
    },
    [syncScrollbar]
  );

  const handleThumbPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const scrollEl = scrollRef.current;
      const trackEl = trackRef.current;
      const thumbEl = thumbRef.current;
      if (!scrollEl || !trackEl || !thumbEl) return;

      const trackWidth =
        trackEl.getBoundingClientRect().width ||
        trackEl.clientWidth ||
        scrollEl.clientWidth;
      const metrics = computeTableScrollbarMetrics({
        clientWidth: scrollEl.clientWidth,
        scrollWidth: scrollEl.scrollWidth,
        scrollLeft: scrollEl.scrollLeft,
        trackWidth,
      });
      if (!metrics || metrics.travel <= 0) return;

      const startX = event.clientX;
      const startScrollLeft = scrollEl.scrollLeft;
      const { travel, overflow } = metrics;

      setIsDragging(true);
      thumbEl.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();

      const onPointerMove = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        scrollEl.scrollLeft = Math.min(
          overflow,
          Math.max(0, startScrollLeft + (deltaX / travel) * overflow)
        );
        syncScrollbar();
      };

      const onPointerEnd = () => {
        dragCleanupRef.current = null;
        setIsDragging(false);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerEnd);
        window.removeEventListener('pointercancel', onPointerEnd);
      };

      dragCleanupRef.current?.();
      dragCleanupRef.current = onPointerEnd;
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerEnd);
      window.addEventListener('pointercancel', onPointerEnd);
    },
    [syncScrollbar]
  );

  const handleCopy = useCallback(
    async (format: TableCopyFormat) => {
      const table = tableRef.current;
      if (!table) return;
      const matrix = extractTableMatrix(table);
      if (matrix.length === 0) return;

      const text =
        format === 'markdown'
          ? formatMatrixAsMarkdown(matrix)
          : formatMatrixAsDelimited(matrix, format === 'csv' ? ',' : '\t');

      try {
        await navigator.clipboard.writeText(text);
        setCopiedFormat(format);
        triggerCopied();
      } catch {
        // Clipboard access depends on host WebView permission state.
      }
    },
    [triggerCopied]
  );

  return (
    <div className="conv-md-table-container">
      <div className="conv-md-table-actions" aria-hidden="false">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={`conv-md-table-copy${copied ? ' is-copied' : ''}`}
              title={copied ? `已复制 (${copiedFormat.toUpperCase()})` : '复制表格'}
              aria-label="复制表格"
            >
              {copied ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              <ChevronDown className="h-2.5 w-2.5 opacity-75" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]">
            <DropdownMenuItem onSelect={() => void handleCopy('markdown')}>
              Copy as Markdown
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleCopy('csv')}>
              Copy as CSV
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleCopy('tsv')}>
              Copy as TSV
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        id={scrollRegionId}
        ref={scrollRef}
        className="conv-md-table-scroll"
        data-overlay-scrollbar-x="off"
        role="group"
        tabIndex={0}
        aria-label="Table"
        onScroll={syncScrollbar}
      >
        <table
          ref={tableRef}
          className={className ? `conv-md-table ${className}` : 'conv-md-table'}
          {...props}
        >
          {children}
        </table>
      </div>
      {hasHorizontalOverflow ? (
        <div
          ref={trackRef}
          className="conv-md-table-scrollbar"
          data-testid="conv-md-table-scrollbar"
          role="scrollbar"
          aria-controls={scrollRegionId}
          aria-orientation="horizontal"
          aria-label="Table horizontal scroll"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
          onPointerDown={handleTrackPointerDown}
        >
          <div
            ref={thumbRef}
            className={`conv-md-table-scrollbar-thumb${isDragging ? ' is-dragging' : ''}`}
            data-testid="conv-md-table-scrollbar-thumb"
            onPointerDown={handleThumbPointerDown}
          />
        </div>
      ) : null}
    </div>
  );
}
