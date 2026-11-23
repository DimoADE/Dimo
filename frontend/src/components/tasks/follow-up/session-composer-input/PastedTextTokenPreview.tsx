import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Maximize2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { writeTextToClipboard } from '@/utils/clipboard';
import {
  elementTooltipTop,
  nativeBrowserSurfaces,
} from './PreviewElementTokenTooltip';

const PREVIEW_MAX_CHARS = 1200;
const PREVIEW_MAX_LINES = 20;

function buildPreviewSnippet(text: string): {
  snippet: string;
  truncated: boolean;
} {
  let limit = Math.min(text.length, PREVIEW_MAX_CHARS);
  let lines = 1;
  let pos = text.indexOf('\n');
  while (pos !== -1 && pos < limit) {
    lines += 1;
    if (lines > PREVIEW_MAX_LINES) {
      limit = pos;
      break;
    }
    pos = text.indexOf('\n', pos + 1);
  }
  const truncated = limit < text.length;
  return {
    snippet: truncated ? text.slice(0, limit) : text,
    truncated,
  };
}

export function PastedTextTokenPreview({
  anchor,
  id,
  text,
  lineCount,
  charCount,
  disabled = false,
  onExpand,
  onRemove,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: HTMLElement;
  id?: string;
  text: string;
  lineCount: number;
  charCount: number;
  disabled?: boolean;
  onExpand?: () => void;
  onRemove?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation('tasks');
  const portalContainer = usePortalContainer();
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({
    left: 0,
    top: 0,
    visibility: 'hidden',
  });

  const preview = useMemo(() => buildPreviewSnippet(text), [text]);

  useEffect(() => {
    setCopied(false);
    return () => {
      if (copyTimerRef.current != null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, [text]);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !anchor.isConnected) return;

      const anchorRect = anchor.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const margin = 8;
      const gap = 7;
      const width = tooltipRect.width || 352;
      const height = tooltipRect.height || 200;
      const centeredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
      const left = Math.min(
        Math.max(margin, centeredLeft),
        Math.max(margin, viewportWidth - width - margin)
      );
      const preferredTop = anchorRect.top - height - gap;
      const top =
        preferredTop >= margin
          ? preferredTop
          : elementTooltipTop({
              anchorTop: anchorRect.top,
              anchorBottom: anchorRect.bottom,
              height,
              gap,
              margin,
              viewportHeight,
              left,
              width,
              blocked: nativeBrowserSurfaces(),
            });

      setPosition({ left, top, visibility: 'visible' });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchor, text]);

  const metaLabel =
    lineCount > 1
      ? t('composer.pastedTextToken.metaLinesChars', {
          lines: lineCount.toLocaleString(),
          chars: charCount.toLocaleString(),
        })
      : t('composer.pastedTextToken.metaChars', {
          chars: charCount.toLocaleString(),
        });

  const handleCopy = () => {
    void writeTextToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copyTimerRef.current != null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1500);
    });
  };

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      data-testid="pasted-text-token-preview"
      className="quote-token-preview fixed z-[2147483646] w-[min(24rem,calc(100vw-1rem))] rounded-lg p-3 text-xs text-foreground"
      style={position}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
        <span>{metaLabel}</span>
      </div>
      <pre className="max-h-48 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-md bg-[var(--surface-control)] px-2 py-1.5 font-mono text-[11px] leading-4 text-foreground">
        {preview.snippet}
        {preview.truncated ? '\n…' : ''}
      </pre>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-1.5 text-[11px]">
        <div className="flex items-center gap-1">
          {!disabled && onExpand ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onExpand();
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid="pasted-text-token-expand"
            >
              <Maximize2 className="h-3 w-3" aria-hidden="true" />
              <span>{t('composer.pastedTextToken.expand')}</span>
            </button>
          ) : null}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              handleCopy();
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            data-testid="pasted-text-token-copy"
          >
            {copied ? (
              <Check className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Copy className="h-3 w-3" aria-hidden="true" />
            )}
            <span>
              {copied
                ? t('composer.pastedTextToken.copied')
                : t('composer.pastedTextToken.copy')}
            </span>
          </button>
        </div>
        {!disabled && onRemove ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
            data-testid="pasted-text-token-remove"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            <span>{t('composer.pastedTextToken.remove')}</span>
          </button>
        ) : null}
      </div>
    </div>,
    portalContainer ?? document.body
  );
}
