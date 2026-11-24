import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Components } from 'hast-util-to-jsx-runtime';
import { loadKatex } from '@/lib/katexRuntime';
import {
  hostFileSrc,
  isDirectBrowserDisplayUrl,
  releaseHostFileSrc,
} from '@/lib/hostAsset';
import { TagReferenceChip } from '@/components/ui/tag-reference-chip';
import {
  parseCommitReferenceUri,
  parseConversationReferenceUri,
  shortCommitSha,
} from '@/components/tasks/follow-up/composerAtReferences';
import { atReferenceChipLabel } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  MEMBER_PLACEHOLDER_PATTERN,
  MemberMentionChip,
  protectMemberMentions,
  useCollaborationMemberMention,
} from '@/features/collaboration/MemberMentionChip';
import { findMarkdownRenderer, useMarkdownRenderers } from '@dimoai/plugin-sdk';
import { PluginBoundary } from '@/components/plugins/PluginBoundary';
import { CodeBlock, CompactCodeBlock } from './CodeBlock';
import { HtmlPreviewBlock, isHtmlPreviewLanguage } from './HtmlPreviewBlock';
import { MermaidDiagram, resetMermaidSvgCache } from './MermaidDiagram';
import {
  MarkdownAlert,
  isMarkdownAlertKind,
} from './MarkdownAlert';
import { MarkdownDetails, MarkdownSummary } from './MarkdownDetails';
import { MarkdownTable } from './MarkdownTable';
import { parseTagReferenceHref } from '@/lib/tagReferenceMarkers';
import {
  MarkdownBlockCache,
  MAX_CACHED_CHARS,
  type MarkdownBlockCacheStats,
} from '@/lib/conversation-rendering/markdownBlockCache';
import {
  decodeFenceInfoLanguage,
  fenceInfoLanguage,
  isMathFenceLanguage,
  splitFencedCodeSegments,
} from '@/lib/conversation-rendering/markdownFences';
import {
  preprocessForBlockSplit,
  splitIntoBlocks,
} from '@/lib/conversation-rendering/markdownPreprocess';
import { prepareSingleMarkdownBlock } from '@/lib/conversation-rendering/streamdownPlugins';
import {
  MATH_PLACEHOLDER_PATTERN,
  protectConversationMath,
} from '@/lib/conversation-rendering/conversationMath';

type ProtectedMath = ReturnType<typeof protectConversationMath>['math'][number];
import { extractYamlFrontmatter } from '@/lib/conversation-rendering/markdownFrontmatterAndTasks';
import { buildMessageFileDisambiguationMap } from '@/lib/conversation-rendering/markdownEngine/collectFileDisplayPaths';
import type { InlineTokenMatcher } from '@/lib/conversation-rendering/markdownEngine/hastInlineTokens';
import {
  extractFenceTitle,
  renderMarkdownToReactElement,
} from '@/lib/conversation-rendering/markdownEngine/markdownProcessor';
import {
  MarkdownFileLinkContext,
  MarkdownResourceLink,
  resolveMarkdownInlineResource,
} from './MarkdownResourceLink';
import {
  isMarkdownImagePath,
  isRenderableRemoteImage,
  resolveLocalMarkdownImagePath,
} from './localImagePaths';

export type AstryxMarkdownProps = {
  /** Markdown string to render. */
  value: string;
  className?: string;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
  softBreaks?: boolean;
  /** Opt-in streaming fade-in and incremental deferred highlighting. */
  isStreaming?: boolean;
  /**
   * Render allowlisted raw HTML (sanitized through rehype-sanitize). Defaults
   * to `true`; pass `false` on surfaces that must keep `<` literal.
   */
  rawHtml?: boolean;
  /** Strip leading YAML frontmatter (`--- ... ---`) for Markdown file previews. */
  stripFrontmatter?: boolean;
  /**
   * Interactive GFM task-list checkbox callback (used by Markdown file previews
   * to write checkbox toggles back to the document).
   */
  onToggleTaskCheckbox?: (taskIndex: number, checked: boolean) => void;
};

type TaskToggleCallback = (taskIndex: number, checked: boolean) => void;

const LARGE_DOC_BLOCK_THRESHOLD = 60;
const TASK_LIST_LINE_COUNT_REGEX =
  /^(?:[ \t]*>[ \t]*)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\](?:[ \t]+|$)/;

function countTaskCheckboxesInBlock(blockText: string): number {
  if (!blockText.includes('[')) return 0;
  let count = 0;
  for (const segment of splitFencedCodeSegments(blockText)) {
    if (segment.kind !== 'text') continue;
    for (const line of segment.text.split('\n')) {
      if (TASK_LIST_LINE_COUNT_REGEX.test(line)) {
        count += 1;
      }
    }
  }
  return count;
}

function flattenNodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenNodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return flattenNodeText(
      (node as { props?: { children?: ReactNode } }).props?.children
    );
  }
  return '';
}

function MarkdownImage({
  src,
  alt,
  taskAttemptId,
  taskId,
  workspacePath,
}: {
  src?: string;
  alt?: string;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
}) {
  const normalizedSrc = (src ?? '').replace(/^<([\s\S]*)>$/, '$1');
  const isVibeImage = normalizedSrc.startsWith('.vibe-images/');
  const { data: metadata, isLoading } = useImageMetadata(
    taskAttemptId,
    isVibeImage ? normalizedSrc : '',
    taskId
  );
  const localImagePath =
    isVibeImage || isRenderableRemoteImage(normalizedSrc)
      ? null
      : resolveLocalMarkdownImagePath(normalizedSrc, workspacePath);
  const vibeFilePath =
    isVibeImage &&
    metadata?.proxy_url &&
    !isDirectBrowserDisplayUrl(metadata.proxy_url)
      ? metadata.proxy_url
      : null;
  const fileSrcPath = vibeFilePath ?? localImagePath;
  const [fileSrcUrl, setFileSrcUrl] = useState<string | null>(null);
  const [fileSrcFailed, setFileSrcFailed] = useState(false);
  useEffect(() => {
    if (!fileSrcPath) {
      setFileSrcUrl(null);
      setFileSrcFailed(false);
      return;
    }
    let cancelled = false;
    let acquiredPath: string | null = null;
    setFileSrcUrl(null);
    setFileSrcFailed(false);
    void hostFileSrc(fileSrcPath)
      .then((url) => {
        if (cancelled) {
          releaseHostFileSrc(fileSrcPath);
          return;
        }
        acquiredPath = fileSrcPath;
        setFileSrcUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFileSrcFailed(true);
      });
    return () => {
      cancelled = true;
      if (acquiredPath) {
        releaseHostFileSrc(acquiredPath);
        acquiredPath = null;
      }
    };
  }, [fileSrcPath]);
  const imageUrl = isVibeImage
    ? isDirectBrowserDisplayUrl(metadata?.proxy_url)
      ? metadata?.proxy_url
      : fileSrcUrl
    : isRenderableRemoteImage(normalizedSrc)
      ? normalizedSrc
      : fileSrcUrl;
  const label = alt || metadata?.file_name || normalizedSrc || 'Image';
  const panelActions = useOptionalPanelActionsContext();
  const openImagePreview = useOpenImagePreview();

  const handleClick = useCallback(
    (event: MouseEvent) => {
      if (!imageUrl) return;
      event.preventDefault();

      // Workspace-local images open as a regular file preview tab so the
      // file tree stays in sync; everything else opens as an image tab.
      if (localImagePath && panelActions) {
        panelActions.openFilePreview(localImagePath, {
          title: metadata?.file_name ?? label,
        });
        return;
      }

      openImagePreview({
        imageUrl,
        altText: label,
        fileName: metadata?.file_name ?? label,
        format: metadata?.format ?? undefined,
        sizeBytes: metadata?.size_bytes,
      });
    },
    [imageUrl, label, localImagePath, metadata, openImagePreview, panelActions]
  );

  if (
    (isVibeImage && isLoading) ||
    (fileSrcPath && !fileSrcUrl && !fileSrcFailed)
  ) {
    return <span className="conv-md-image-placeholder">Loading image...</span>;
  }

  if (!imageUrl) {
    return (
      <MarkdownResourceLink
        href={normalizedSrc}
        workspacePath={workspacePath}
        pathTarget={
          fileSrcPath
            ? {
                path: fileSrcPath,
                displayPath: normalizedSrc,
                nodeType: 'file',
              }
            : undefined
        }
      >
        {label}
      </MarkdownResourceLink>
    );
  }

  return (
    <button
      type="button"
      className="conv-md-image-frame"
      onClick={handleClick}
      title={label}
    >
      <img src={imageUrl} alt={label} className="conv-md-image" />
    </button>
  );
}

type MarkdownComponentContext = {
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
  isStreaming?: boolean;
  deferCodeHighlight?: boolean;
  taskToggleRef?: RefObject<TaskToggleCallback | undefined>;
  hasTaskToggle?: boolean;
};

function analyzeStreamingFenceState(value: string): {
  hasCodeFence: boolean;
  hasUnclosedFence: boolean;
} {
  if (!value.includes('```') && !value.includes('~~~')) {
    return { hasCodeFence: false, hasUnclosedFence: false };
  }
  const segments = splitFencedCodeSegments(value);
  let hasCodeFence = false;
  let hasUnclosedFence = false;
  for (const segment of segments) {
    if (segment.kind === 'openFence') {
      hasCodeFence = true;
      hasUnclosedFence = true;
    } else if (segment.kind === 'closedFence') {
      hasCodeFence = true;
    }
  }
  return { hasCodeFence, hasUnclosedFence };
}

function neutralizeUnclosedMathFence(value: string): string {
  const segments = splitFencedCodeSegments(value);
  const last = segments[segments.length - 1];
  if (!last || last.kind !== 'openFence') {
    return value;
  }
  if (!isMathFenceLanguage(fenceInfoLanguage(last.text))) {
    return value;
  }
  const rewrittenOpen = last.text.replace(
    /^(\s*)(`{3,}|~{3,})([^\n\r]*)/,
    '$1$2text'
  );
  return (
    segments
      .slice(0, -1)
      .map((segment) => segment.text)
      .join('') + rewrittenOpen
  );
}

function MarkdownCodeSwitch({
  code,
  language: rawLanguage,
  title,
  taskAttemptId,
  taskId,
  workspacePath,
  isStreaming,
  deferCodeHighlight,
}: MarkdownComponentContext & {
  code: string;
  language?: string;
  title?: string;
}) {
  const renderers = useMarkdownRenderers();
  const language = decodeFenceInfoLanguage(rawLanguage);
  const customRenderer =
    renderers.length > 0 ? findMarkdownRenderer(code, language) : undefined;
  if (customRenderer) {
    const pluginId = customRenderer.pluginId ?? 'unknown-plugin';
    const CustomComponent = customRenderer.component;
    const rendererProps = {
      code,
      language,
      isStreaming,
      workspacePath,
      taskAttemptId,
      taskId,
    };
    return (
      <PluginBoundary pluginId={pluginId} slot="markdown.codeblock">
        {CustomComponent ? (
          <CustomComponent {...rendererProps} />
        ) : customRenderer.render ? (
          (customRenderer.render(rendererProps) as ReactNode)
        ) : null}
      </PluginBoundary>
    );
  }
  const deferHighlight = Boolean(deferCodeHighlight);
  if (!deferHighlight && language?.toLowerCase() === 'mermaid') {
    return <MermaidDiagram value={code} />;
  }
  if (isHtmlPreviewLanguage(language)) {
    return (
      <HtmlPreviewBlock
        code={code}
        workspacePath={workspacePath}
        isStreaming={isStreaming}
      />
    );
  }
  const className =
    language && language !== 'plaintext' ? `language-${language}` : undefined;
  const isSingleLine = !deferHighlight && !title && !code.includes('\n');
  if (isSingleLine) {
    return (
      <CompactCodeBlock
        className={className}
        value={code}
        deferHighlight={deferHighlight}
      />
    );
  }
  return (
    <CodeBlock
      className={className}
      value={code}
      title={title}
      isStreaming={Boolean(isStreaming && deferHighlight)}
      deferHighlight={deferHighlight}
    />
  );
}

function KatexMath({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadKatex()
      .then((katex) => {
        if (cancelled) return;
        setHtml(
          katex.renderToString(tex, {
            displayMode: display,
            throwOnError: false,
            strict: false,
          })
        );
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [display, tex]);

  if (html) {
    return (
      <span
        className={display ? 'katex-display' : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return <span>{display ? `$$${tex}$$` : `$${tex}$`}</span>;
}

type BlockInlineRegistries = {
  math: readonly ProtectedMath[];
  mentions: readonly string[];
  taskIndexOffset: number;
};

type PrePropsWithMeta = ComponentPropsWithoutRef<'pre'> & {
  'data-code-block'?: string;
  'data-language'?: string;
  'data-meta'?: string;
};

type CodePropsWithMeta = ComponentPropsWithoutRef<'code'> & {
  'data-block-code'?: string;
};

type DivPropsWithAlert = ComponentPropsWithoutRef<'div'> & {
  'data-markdown-alert'?: string;
  'data-markdown-alert-title'?: string;
};

type SpanPropsWithToken = ComponentPropsWithoutRef<'span'> & {
  'data-md-token'?: string;
  'data-md-token-index'?: string;
};

type AnchorPropsWithFootnote = ComponentPropsWithoutRef<'a'> & {
  'data-footnote-ref'?: string | boolean;
  'data-footnote-backref'?: string | boolean;
};

type InputPropsWithTask = ComponentPropsWithoutRef<'input'> & {
  'data-task-index'?: string;
};

function createBaseMarkdownComponents(
  ctx: MarkdownComponentContext
): Partial<Components> {
  const {
    taskAttemptId,
    taskId,
    workspacePath,
    isStreaming,
    deferCodeHighlight,
  } = ctx;

  return {
    pre: ({
      children,
      'data-code-block': isCodeBlock,
      'data-language': dataLanguage,
      'data-meta': dataMeta,
      ...rest
    }: PrePropsWithMeta) => {
      if (isCodeBlock === 'true') {
        const rawCode = flattenNodeText(children).replace(/\r?\n$/, '');
        const title = extractFenceTitle(dataMeta);
        return (
          <MarkdownCodeSwitch
            code={rawCode}
            language={dataLanguage}
            title={title}
            taskAttemptId={taskAttemptId}
            taskId={taskId}
            workspacePath={workspacePath}
            isStreaming={isStreaming}
            deferCodeHighlight={deferCodeHighlight}
          />
        );
      }
      return <pre {...rest}>{children}</pre>;
    },
    code: ({
      children,
      'data-block-code': isBlockCode,
      ...rest
    }: CodePropsWithMeta) => {
      if (isBlockCode === 'true') {
        return <code {...rest}>{children}</code>;
      }

      const text = flattenNodeText(children).trim();
      const resource = resolveMarkdownInlineResource(text, workspacePath);

      if (resource) {
        return (
          <MarkdownResourceLink
            href={resource.href}
            pathTarget={resource.pathTarget}
            workspacePath={workspacePath}
          >
            {text || children}
          </MarkdownResourceLink>
        );
      }

      return <code {...rest}>{text || children}</code>;
    },
    a: ({
      href,
      children,
      'data-footnote-ref': footnoteRef,
      'data-footnote-backref': footnoteBackref,
      ...rest
    }: AnchorPropsWithFootnote) => {
      if (footnoteRef != null || footnoteBackref != null) {
        return (
          <a
            href={href}
            data-footnote-ref={footnoteRef}
            data-footnote-backref={footnoteBackref}
            {...rest}
          >
            {children}
          </a>
        );
      }

      const tagReferencePayload = href ? parseTagReferenceHref(href) : null;
      if (tagReferencePayload) {
        return (
          <TagReferenceChip
            tagName={tagReferencePayload.tagName}
            content={tagReferencePayload.content}
          />
        );
      }

      const conversationId = href ? parseConversationReferenceUri(href) : null;
      if (conversationId) {
        const label = atReferenceChipLabel(
          flattenNodeText(children) || conversationId
        );
        return (
          <span className="mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded-md bg-[hsl(var(--info)/0.12)] px-1.5 py-0.5 align-baseline text-sm text-[hsl(var(--info))]">
            <span className="truncate font-medium">{label}</span>
          </span>
        );
      }

      const commit = href ? parseCommitReferenceUri(href) : null;
      if (commit) {
        const label = atReferenceChipLabel(
          flattenNodeText(children) || shortCommitSha(commit.sha)
        );
        return (
          <span
            className="mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded-md bg-[hsl(var(--info)/0.12)] px-1.5 py-0.5 align-baseline text-sm text-[hsl(var(--info))]"
            title={commit.sha}
          >
            <span className="truncate font-medium">{label}</span>
          </span>
        );
      }

      const childrenText = flattenNodeText(children);
      const imageHref =
        href &&
        (isMarkdownImagePath(href) ||
          href.startsWith('data:image/') ||
          href.startsWith('blob:')) &&
        !parseTagReferenceHref(href)
          ? href
          : null;

      if (imageHref) {
        return (
          <MarkdownImage
            src={imageHref}
            alt={childrenText || undefined}
            taskAttemptId={taskAttemptId}
            taskId={taskId}
            workspacePath={workspacePath}
          />
        );
      }

      return (
        <MarkdownResourceLink href={href} workspacePath={workspacePath}>
          {children}
        </MarkdownResourceLink>
      );
    },
    img: ({ src, alt }) => (
      <MarkdownImage
        src={src}
        alt={alt}
        taskAttemptId={taskAttemptId}
        taskId={taskId}
        workspacePath={workspacePath}
      />
    ),
    table: ({ children, ...rest }) => (
      <MarkdownTable {...rest}>{children}</MarkdownTable>
    ),
    details: ({ children, open, ...rest }) => (
      <MarkdownDetails open={Boolean(open)} {...rest}>
        {children}
      </MarkdownDetails>
    ),
    summary: ({ children, ...rest }) => (
      <MarkdownSummary {...rest}>{children}</MarkdownSummary>
    ),
    div: ({
      children,
      'data-markdown-alert': alertKind,
      'data-markdown-alert-title': alertTitle,
      ...rest
    }: DivPropsWithAlert) => {
      if (isMarkdownAlertKind(alertKind)) {
        return (
          <MarkdownAlert kind={alertKind} title={alertTitle}>
            {children}
          </MarkdownAlert>
        );
      }
      return <div {...rest}>{children}</div>;
    },
  };
}

function withBlockDynamicComponents(
  baseComponents: Partial<Components>,
  registries: BlockInlineRegistries,
  taskToggleRef?: RefObject<TaskToggleCallback | undefined>,
  hasTaskToggle?: boolean
): Partial<Components> {
  const needsSpan =
    registries.math.length > 0 || registries.mentions.length > 0;
  const needsCheckbox = Boolean(hasTaskToggle);

  if (!needsSpan && !needsCheckbox) {
    return baseComponents;
  }

  return {
    ...baseComponents,
    ...(needsSpan
      ? {
          span: ({
            children,
            'data-md-token': tokenKind,
            'data-md-token-index': tokenIndexRaw,
            ...rest
          }: SpanPropsWithToken) => {
            if (tokenKind === 'math' && tokenIndexRaw != null) {
              const math = registries.math[Number(tokenIndexRaw)];
              if (!math) return null;
              return <KatexMath tex={math.tex} display={math.display} />;
            }
            if (tokenKind === 'member' && tokenIndexRaw != null) {
              const nickname = registries.mentions[Number(tokenIndexRaw)];
              if (!nickname) return null;
              return <MemberMentionChip nickname={nickname} />;
            }
            return <span {...rest}>{children}</span>;
          },
        }
      : {}),
    ...(needsCheckbox
      ? {
          input: ({
            type,
            checked,
            disabled: _disabled,
            'data-task-index': localIndexRaw,
            ...rest
          }: InputPropsWithTask) => {
            if (type === 'checkbox' && localIndexRaw != null) {
              const globalIndex =
                registries.taskIndexOffset + Number(localIndexRaw);
              return (
                <input
                  {...rest}
                  type="checkbox"
                  checked={Boolean(checked)}
                  disabled={false}
                  className="conv-md-task-checkbox is-interactive"
                  onChange={(event) => {
                    taskToggleRef?.current?.(globalIndex, event.target.checked);
                  }}
                />
              );
            }
            return (
              <input
                {...rest}
                type={type}
                checked={checked}
                disabled={_disabled}
              />
            );
          },
        }
      : {}),
  };
}

function arePropsEqual(prev: AstryxMarkdownProps, next: AstryxMarkdownProps) {
  return (
    prev.value === next.value &&
    prev.className === next.className &&
    prev.taskAttemptId === next.taskAttemptId &&
    prev.taskId === next.taskId &&
    prev.workspacePath === next.workspacePath &&
    prev.softBreaks === next.softBreaks &&
    prev.isStreaming === next.isStreaming &&
    prev.rawHtml === next.rawHtml &&
    prev.stripFrontmatter === next.stripFrontmatter &&
    prev.onToggleTaskCheckbox === next.onToggleTaskCheckbox
  );
}

const markdownBlockElementCache = new MarkdownBlockCache<ReactElement>(
  MAX_CACHED_CHARS
);

export function getMarkdownBlockElementCacheStats(): MarkdownBlockCacheStats {
  return markdownBlockElementCache.stats();
}

export function resetMarkdownBlockElementCache(): void {
  markdownBlockElementCache.clear();
  markdownBlockElementCache.resetStats();
  resetMermaidSvgCache();
}

type CompileMarkdownBlockOptions = {
  softBreaks?: boolean;
  rawHtml?: boolean;
  enableMemberMentions: boolean;
  knownNicknames: readonly string[];
  baseComponents: Partial<Components>;
  taskToggleRef?: RefObject<TaskToggleCallback | undefined>;
  hasTaskToggle?: boolean;
  taskIndexOffset?: number;
};

function buildBlockElementCacheKey(
  blockHash: string,
  blockText: string,
  options: {
    softBreaks?: boolean;
    rawHtml?: boolean;
    workspacePath?: string | null;
    taskAttemptId?: string;
    taskId?: string;
    enableMemberMentions: boolean;
    knownNicknames: readonly string[];
  }
): string {
  const mentionSignature =
    options.enableMemberMentions && blockText.includes('@')
      ? `1:${options.knownNicknames.join('\u0001')}`
      : '0';
  return `${blockHash}|s=${options.softBreaks ? 1 : 0}|h=${options.rawHtml !== false ? 1 : 0}|w=${options.workspacePath ?? ''}|a=${options.taskAttemptId ?? ''}|t=${options.taskId ?? ''}|m=${mentionSignature}`;
}

function compileMarkdownBlockElement(
  blockText: string,
  options: CompileMarkdownBlockOptions
): ReactElement {
  const prepared = prepareSingleMarkdownBlock(blockText, {
    softBreaks: options.softBreaks,
  });
  // Rewrite empty link destinations (`[text]()`) to `#` so workspace path
  // resolution can still read the link label.
  const withLinks = prepared.replace(/\[([^\]\n]+)\]\(\)/g, '[$1](#)');
  const withMath = protectConversationMath(withLinks);
  const withMentions = options.enableMemberMentions
    ? protectMemberMentions(withMath.text, options.knownNicknames)
    : { text: withMath.text, mentions: [] };

  const inlineTokens: InlineTokenMatcher[] = [];
  if (withMath.math.length > 0) {
    inlineTokens.push({ kind: 'math', pattern: MATH_PLACEHOLDER_PATTERN });
  }
  if (withMentions.mentions.length > 0) {
    inlineTokens.push({
      kind: 'member',
      pattern: MEMBER_PLACEHOLDER_PATTERN,
    });
  }

  const components = withBlockDynamicComponents(
    options.baseComponents,
    {
      math: withMath.math,
      mentions: withMentions.mentions,
      taskIndexOffset: options.taskIndexOffset ?? 0,
    },
    options.taskToggleRef,
    options.hasTaskToggle
  );

  return renderMarkdownToReactElement(withMentions.text, {
    rawHtml: options.rawHtml,
    inlineTokens,
    components,
  });
}

export const AstryxMarkdown = memo(function AstryxMarkdown({
  value,
  className,
  taskAttemptId,
  taskId,
  workspacePath,
  softBreaks,
  isStreaming,
  rawHtml,
  stripFrontmatter,
  onToggleTaskCheckbox,
}: AstryxMarkdownProps) {
  const memberMentionCtx = useCollaborationMemberMention();
  const taskToggleRef = useRef<TaskToggleCallback | undefined>(
    onToggleTaskCheckbox
  );
  taskToggleRef.current = onToggleTaskCheckbox;
  const hasTaskToggle = Boolean(onToggleTaskCheckbox);

  const effectiveValue = useMemo(() => {
    if (!stripFrontmatter) return value;
    return extractYamlFrontmatter(value).body;
  }, [stripFrontmatter, value]);

  const fileDisambiguationMap = useMemo(
    () => buildMessageFileDisambiguationMap(effectiveValue, workspacePath),
    [effectiveValue, workspacePath]
  );

  const settledComponents = useMemo(
    () =>
      createBaseMarkdownComponents({
        taskAttemptId,
        taskId,
        workspacePath,
        isStreaming: false,
        deferCodeHighlight: false,
        taskToggleRef,
        hasTaskToggle,
      }),
    [hasTaskToggle, taskAttemptId, taskId, workspacePath]
  );

  const activeComponents = useMemo(
    () =>
      isStreaming
        ? createBaseMarkdownComponents({
            taskAttemptId,
            taskId,
            workspacePath,
            isStreaming: true,
            deferCodeHighlight: false,
            taskToggleRef,
            hasTaskToggle,
          })
        : settledComponents,
    [
      hasTaskToggle,
      isStreaming,
      settledComponents,
      taskAttemptId,
      taskId,
      workspacePath,
    ]
  );

  const deferredStreamingComponents = useMemo(
    () =>
      isStreaming
        ? createBaseMarkdownComponents({
            taskAttemptId,
            taskId,
            workspacePath,
            isStreaming: true,
            deferCodeHighlight: true,
            taskToggleRef,
            hasTaskToggle,
          })
        : settledComponents,
    [
      hasTaskToggle,
      isStreaming,
      settledComponents,
      taskAttemptId,
      taskId,
      workspacePath,
    ]
  );

  const renderedBlocks = useMemo(() => {
    const { body, tagAppendix, mathSpans } =
      preprocessForBlockSplit(effectiveValue);
    const blocks = splitIntoBlocks(body, mathSpans, Boolean(isStreaming));
    const elements: ReactElement[] = [];
    let runningTaskOffset = 0;

    for (const block of blocks) {
      const blockTaskCount = hasTaskToggle
        ? countTaskCheckboxesInBlock(block.text)
        : 0;
      const blockTaskOffset = runningTaskOffset;
      runningTaskOffset += blockTaskCount;

      const canUseElementCache =
        block.closed && !(hasTaskToggle && blockTaskCount > 0);

      if (canUseElementCache) {
        const cacheKey = buildBlockElementCacheKey(block.hash, block.text, {
          softBreaks,
          rawHtml,
          workspacePath,
          taskAttemptId,
          taskId,
          enableMemberMentions: memberMentionCtx.enableMemberMentions,
          knownNicknames: memberMentionCtx.knownNicknames,
        });
        const cached = markdownBlockElementCache.hit(cacheKey, block.text);
        if (cached) {
          elements.push(cached);
          continue;
        }
        const compiled = compileMarkdownBlockElement(block.text, {
          softBreaks,
          rawHtml,
          enableMemberMentions: memberMentionCtx.enableMemberMentions,
          knownNicknames: memberMentionCtx.knownNicknames,
          baseComponents: settledComponents,
          taskToggleRef,
          hasTaskToggle: false,
        });
        markdownBlockElementCache.set(cacheKey, block.text, compiled);
        elements.push(compiled);
        continue;
      }

      const fenceState = isStreaming
        ? analyzeStreamingFenceState(block.text)
        : { hasCodeFence: false, hasUnclosedFence: false };
      const activeBlockText = fenceState.hasUnclosedFence
        ? neutralizeUnclosedMathFence(block.text)
        : block.text;

      elements.push(
        compileMarkdownBlockElement(activeBlockText, {
          softBreaks,
          rawHtml,
          enableMemberMentions: memberMentionCtx.enableMemberMentions,
          knownNicknames: memberMentionCtx.knownNicknames,
          baseComponents: fenceState.hasUnclosedFence
            ? deferredStreamingComponents
            : activeComponents,
          taskToggleRef,
          hasTaskToggle: hasTaskToggle && blockTaskCount > 0,
          taskIndexOffset: blockTaskOffset,
        })
      );
    }

    if (tagAppendix) {
      const appendixTaskCount = hasTaskToggle
        ? countTaskCheckboxesInBlock(tagAppendix)
        : 0;
      const appendixTaskOffset = runningTaskOffset;
      const appendixFenceState = isStreaming
        ? analyzeStreamingFenceState(tagAppendix)
        : { hasCodeFence: false, hasUnclosedFence: false };
      const appendixText = appendixFenceState.hasUnclosedFence
        ? neutralizeUnclosedMathFence(tagAppendix)
        : tagAppendix;
      elements.push(
        compileMarkdownBlockElement(appendixText, {
          softBreaks,
          rawHtml,
          enableMemberMentions: memberMentionCtx.enableMemberMentions,
          knownNicknames: memberMentionCtx.knownNicknames,
          baseComponents: appendixFenceState.hasUnclosedFence
            ? deferredStreamingComponents
            : activeComponents,
          taskToggleRef,
          hasTaskToggle: hasTaskToggle && appendixTaskCount > 0,
          taskIndexOffset: appendixTaskOffset,
        })
      );
    }

    return elements;
  }, [
    activeComponents,
    deferredStreamingComponents,
    effectiveValue,
    hasTaskToggle,
    isStreaming,
    memberMentionCtx.enableMemberMentions,
    memberMentionCtx.knownNicknames,
    rawHtml,
    settledComponents,
    softBreaks,
    taskAttemptId,
    taskId,
    workspacePath,
  ]);

  const prevKeyedBlocksRef = useRef<
    Array<{ raw: ReactElement; keyed: ReactElement }>
  >([]);

  const isLargeDocument = renderedBlocks.length > LARGE_DOC_BLOCK_THRESHOLD;

  const keyedBlocks = useMemo(() => {
    const previous = prevKeyedBlocksRef.current;
    const next: Array<{ raw: ReactElement; keyed: ReactElement }> = new Array(
      renderedBlocks.length
    );

    for (let index = 0; index < renderedBlocks.length; index += 1) {
      const raw = renderedBlocks[index]!;
      const prevEntry = previous[index];
      if (prevEntry && prevEntry.raw === raw) {
        next[index] = prevEntry;
      } else {
        next[index] = {
          raw,
          keyed: isLargeDocument ? (
            <div key={`block-${index}`} className="conv-md-chunk">
              {raw}
            </div>
          ) : (
            <Fragment key={`block-${index}`}>{raw}</Fragment>
          ),
        };
      }
    }

    prevKeyedBlocksRef.current = next;
    return next.map((entry) => entry.keyed);
  }, [isLargeDocument, renderedBlocks]);

  return (
    <MarkdownFileLinkContext.Provider value={fileDisambiguationMap}>
      <div
        className={`conv-markdown${className ? ` ${className}` : ''}`}
        data-streaming={isStreaming ? 'true' : undefined}
      >
        {keyedBlocks}
      </div>
    </MarkdownFileLinkContext.Provider>
  );
}, arePropsEqual);
