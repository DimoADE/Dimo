import { memo, useEffect, useId, useMemo, useState } from 'react';
import { sanitizeMermaidSvg } from '@/lib/conversation-rendering/mermaidSvg';

type MermaidDiagramProps = {
  value: string;
};

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; message: string };

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function sanitizeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '') || 'diagram';
}

// mermaid.initialize sets global singleton config; only re-run it when the theme
// actually changes rather than on every diagram value update.
let lastMermaidTheme: 'default' | 'dark' | null = null;

async function loadMermaid(theme: 'default' | 'dark') {
  const { default: mermaid } = await import('mermaid');
  if (lastMermaidTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      // `strict`/`sandbox` render into an iframe whose contentDocument is
      // often null in the desktop webview, so mermaid then reads
      // `element.firstChild` on null. `antiscript` keeps HTML labels, and
      // we still sanitize the SVG before inserting it.
      securityLevel: 'antiscript',
      // A parse error otherwise appends a bomb SVG to document.body. The
      // component already renders its own error state.
      suppressErrorRendering: true,
      // Inline SVG can paint foreignObject HTML labels; the data-URL <img>
      // path could not. Keep htmlLabels on so node text stays complete.
      htmlLabels: true,
      theme,
      fontFamily:
        'Noto Sans SC Variable, Source Han Sans SC, Source Han Sans CN, Noto Sans CJK SC, Noto Sans SC, 思源黑体, sans-serif',
    });
    lastMermaidTheme = theme;
  }
  return mermaid;
}

function getMermaidTheme(): 'default' | 'dark' {
  if (typeof document === 'undefined') {
    return 'default';
  }

  return document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'default';
}

const MAX_MERMAID_SVG_CACHE = 64;
const mermaidSvgCache = new Map<string, string>();

function getCachedMermaidSvg(cacheKey: string): string | undefined {
  const cached = mermaidSvgCache.get(cacheKey);
  if (cached !== undefined) {
    mermaidSvgCache.delete(cacheKey);
    mermaidSvgCache.set(cacheKey, cached);
  }
  return cached;
}

function setCachedMermaidSvg(cacheKey: string, svg: string): void {
  if (mermaidSvgCache.has(cacheKey)) {
    mermaidSvgCache.delete(cacheKey);
  }
  mermaidSvgCache.set(cacheKey, svg);
  while (mermaidSvgCache.size > MAX_MERMAID_SVG_CACHE) {
    const oldestKey = mermaidSvgCache.keys().next().value;
    if (oldestKey === undefined) break;
    mermaidSvgCache.delete(oldestKey);
  }
}

export function resetMermaidSvgCache(): void {
  mermaidSvgCache.clear();
  lastMermaidTheme = null;
}

const themeSubscribers = new Set<(theme: 'default' | 'dark') => void>();
let sharedThemeObserver: MutationObserver | null = null;
let lastObservedTheme: 'default' | 'dark' | null = null;

function subscribeMermaidTheme(
  listener: (theme: 'default' | 'dark') => void
): () => void {
  if (
    typeof document === 'undefined' ||
    typeof MutationObserver === 'undefined'
  ) {
    return () => {};
  }
  themeSubscribers.add(listener);
  if (!sharedThemeObserver) {
    lastObservedTheme = getMermaidTheme();
    sharedThemeObserver = new MutationObserver(() => {
      const nextTheme = getMermaidTheme();
      if (nextTheme === lastObservedTheme) return;
      lastObservedTheme = nextTheme;
      for (const subscriber of themeSubscribers) {
        subscriber(nextTheme);
      }
    });
    sharedThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  return () => {
    themeSubscribers.delete(listener);
    if (themeSubscribers.size === 0 && sharedThemeObserver) {
      sharedThemeObserver.disconnect();
      sharedThemeObserver = null;
      lastObservedTheme = null;
    }
  };
}

function useMermaidTheme(): 'default' | 'dark' {
  const [theme, setTheme] = useState(getMermaidTheme);

  useEffect(() => {
    setTheme(getMermaidTheme());
    return subscribeMermaidTheme(setTheme);
  }, []);

  return theme;
}

export const MermaidDiagram = memo(function MermaidDiagram({
  value,
}: MermaidDiagramProps) {
  const reactId = useId();
  const theme = useMermaidTheme();
  const cacheKey = `${theme}:${value}`;
  const diagramId = useMemo(
    () => `mermaid-${sanitizeDomId(reactId)}-${hashString(value)}`,
    [reactId, value]
  );
  const [renderState, setRenderState] = useState<RenderState>(() => {
    const cached = getCachedMermaidSvg(cacheKey);
    return cached ? { status: 'ready', svg: cached } : { status: 'loading' };
  });

  useEffect(() => {
    const cached = getCachedMermaidSvg(cacheKey);
    if (cached) {
      setRenderState({ status: 'ready', svg: cached });
      return;
    }

    let cancelled = false;

    async function renderDiagram() {
      setRenderState((current) =>
        current.status === 'ready' ? current : { status: 'loading' }
      );

      const container = document.createElement('div');
      container.setAttribute('data-mermaid-host', diagramId);
      container.style.cssText =
        'position:absolute;left:-9999px;top:0;width:800px;height:0;overflow:hidden;';
      document.body.appendChild(container);

      try {
        const mermaid = await loadMermaid(theme);
        const { svg } = await mermaid.render(diagramId, value, container);
        const sanitized = sanitizeMermaidSvg(svg);
        if (!sanitized) {
          throw new Error(
            '\u56fe\u8868 SVG \u65e0\u6cd5\u5b89\u5168\u6e32\u67d3'
          );
        }

        setCachedMermaidSvg(cacheKey, sanitized);
        if (!cancelled) {
          setRenderState({ status: 'ready', svg: sanitized });
        }
      } catch (error) {
        if (!cancelled) {
          setRenderState({
            status: 'error',
            message:
              error instanceof Error && error.message
                ? error.message
                : '\u672a\u77e5\u7684 Mermaid \u6e32\u67d3\u9519\u8bef',
          });
        }
      } finally {
        container.remove();
        document.getElementById(`d${diagramId}`)?.remove();
        document.getElementById(`i${diagramId}`)?.remove();
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, diagramId, theme, value]);

  return (
    <figure className="conv-md-mermaid">
      {renderState.status === 'loading' ? (
        <div
          className="conv-md-mermaid-status"
          role="status"
          aria-live="polite"
        >
          {'\u6b63\u5728\u6e32\u67d3\u56fe\u8868...'}
        </div>
      ) : null}

      {renderState.status === 'ready' ? (
        <div
          className="conv-md-mermaid-svg"
          role="img"
          aria-label={'Mermaid \u56fe\u8868'}
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      ) : null}

      {renderState.status === 'error' ? (
        <div className="conv-md-mermaid-error" role="alert">
          <div className="conv-md-mermaid-error-title">
            {'\u56fe\u8868\u6e32\u67d3\u5931\u8d25'}
          </div>
          <div className="conv-md-mermaid-error-detail">
            {renderState.message}
          </div>
          <pre className="conv-md-mermaid-source">
            <code>{value}</code>
          </pre>
        </div>
      ) : null}
    </figure>
  );
});
