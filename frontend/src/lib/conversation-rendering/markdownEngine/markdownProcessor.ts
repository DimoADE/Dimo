import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import type { ReactElement } from 'react';
import type { Element, Properties, Root as HastRoot } from 'hast';
import type { Code, Root as MdastRoot } from 'mdast';
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import { RAW_HTML_ALLOWED_TAGS } from '../rawHtml';
import {
  applyHastInlineTokens,
  type InlineTokenMatcher,
} from './hastInlineTokens';
import { remarkFilterRawHtml } from './remarkFilterRawHtml';
import { remarkGithubAlerts } from './remarkGithubAlerts';
import { normalizeOverIndentedNestedLists } from './remarkNormalizeListIndentation';

const WINDOWS_DRIVE_LETTERS = Array.from({ length: 26 }, (_, idx) =>
  String.fromCharCode(97 + idx)
);

const SAFE_DATA_IMAGE_REGEX =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|ico|avif);/i;

const ALLOWED_TAG_NAMES = Array.from(
  new Set([
    ...(defaultSchema.tagNames ?? []),
    ...Array.from(RAW_HTML_ALLOWED_TAGS),
    'input',
  ])
);

const DIMO_SANITIZE_SCHEMA: Parameters<typeof rehypeSanitize>[0] = {
  ...defaultSchema,
  tagNames: ALLOWED_TAG_NAMES,
  clobberPrefix: 'md-fn-',
  attributes: {
    ...defaultSchema.attributes,
    '*': [
      'title',
      'dir',
      'lang',
      'id',
      'ariaLabel',
      'ariaHidden',
      'ariaDescribedBy',
      'ariaLabelledBy',
    ],
    a: [
      'href',
      'title',
      'id',
      'dataFootnoteRef',
      'dataFootnoteBackref',
      ['className', 'data-footnote-backref'],
      'ariaDescribedBy',
      'ariaLabel',
      'ariaLabelledBy',
    ],
    img: ['src', 'alt', 'title', 'width', 'height'],
    code: [['className', /^language-[\w.+-]+$/], 'dataMeta'],
    div: ['dataMarkdownAlert', 'dataMarkdownAlertTitle'],
    details: ['open'],
    ol: ['start', 'reversed', 'type', 'dataOlDigits'],
    ul: [['className', 'contains-task-list']],
    li: [['className', 'task-list-item'], 'id'],
    input: [['type', 'checkbox'], 'checked', 'disabled', 'dataTaskIndex'],
    section: ['dataFootnotes', ['className', 'footnotes']],
    h1: ['id', ['className', 'sr-only']],
    h2: ['id', ['className', 'sr-only']],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
    sup: ['id'],
    th: ['align', 'colSpan', 'rowSpan', 'scope'],
    td: ['align', 'colSpan', 'rowSpan'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [
      'http',
      'https',
      'mailto',
      'tel',
      'file',
      'tag-ref',
      'dimo',
      'vibex',
      'blob',
      'data',
      ...WINDOWS_DRIVE_LETTERS,
    ],
    src: [
      'http',
      'https',
      'file',
      'asset',
      'blob',
      'data',
      ...WINDOWS_DRIVE_LETTERS,
    ],
  },
};

function remarkPreserveCodeMeta() {
  return (tree: MdastRoot) => {
    visit(tree, 'code', (node: Code) => {
      const meta = node.meta?.trim();
      if (!meta) return;
      const existingData = (node.data ?? {}) as Record<string, unknown>;
      const existingHProps =
        (existingData.hProperties as Record<string, unknown> | undefined) ?? {};
      node.data = {
        ...existingData,
        hProperties: {
          ...existingHProps,
          dataMeta: meta,
        },
      };
    });
  };
}

function rehypeListMetadata() {
  return (tree: HastRoot) => {
    let taskCheckboxIndex = 0;

    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'pre') {
        const firstElementChild = node.children.find(
          (child): child is Element =>
            child.type === 'element' && child.tagName === 'code'
        );
        if (firstElementChild) {
          const rawClassName: unknown = firstElementChild.properties?.className;
          const classes: string[] = Array.isArray(rawClassName)
            ? rawClassName.map(String)
            : typeof rawClassName === 'string'
              ? rawClassName.split(/\s+/)
              : [];
          const langClass = classes.find((cls) => cls.startsWith('language-'));
          const language = langClass
            ? langClass.slice('language-'.length)
            : undefined;
          const meta =
            typeof firstElementChild.properties?.dataMeta === 'string'
              ? firstElementChild.properties.dataMeta
              : undefined;

          node.properties = {
            ...(node.properties ?? {}),
            dataCodeBlock: 'true',
            ...(language ? { dataLanguage: language } : {}),
            ...(meta ? { dataMeta: meta } : {}),
          };
          firstElementChild.properties = {
            ...(firstElementChild.properties ?? {}),
            dataBlockCode: 'true',
          };
        }
        return;
      }

      if (node.tagName === 'ol') {
        const startRaw = node.properties?.start;
        const start =
          typeof startRaw === 'number'
            ? startRaw
            : typeof startRaw === 'string' && /^\d+$/.test(startRaw)
              ? Number(startRaw)
              : 1;
        let itemCount = 0;
        for (const child of node.children) {
          if (child.type === 'element' && child.tagName === 'li') {
            itemCount += 1;
          }
        }
        const maxNum = start + Math.max(0, itemCount - 1);
        if (maxNum >= 100) {
          node.properties = {
            ...(node.properties ?? {}),
            dataOlDigits: '3',
          };
        } else if (maxNum >= 10) {
          node.properties = {
            ...(node.properties ?? {}),
            dataOlDigits: '2',
          };
        }
        return;
      }

      if (
        node.tagName === 'input' &&
        node.properties?.type === 'checkbox'
      ) {
        node.properties = {
          ...(node.properties ?? {}),
          dataTaskIndex: String(taskCheckboxIndex),
        };
        taskCheckboxIndex += 1;
      }
    });
  };
}

function sanitizeDataUrlProperty(
  properties: Properties | undefined,
  key: 'href' | 'src'
): void {
  if (!properties) return;
  const raw = properties[key];
  if (typeof raw !== 'string') return;
  const trimmed = raw.trim();
  if (/^data:/i.test(trimmed) && !SAFE_DATA_IMAGE_REGEX.test(trimmed)) {
    delete properties[key];
  }
}

function rehypeSanitizeDataUrls() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'a') {
        sanitizeDataUrlProperty(node.properties, 'href');
      } else if (node.tagName === 'img') {
        sanitizeDataUrlProperty(node.properties, 'src');
      }
    });
  };
}

const plainProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkPreserveCodeMeta)
  .use(remarkFilterRawHtml, { rawHtml: false })
  .use(remarkGithubAlerts)
  .use(remarkRehype)
  .use(rehypeSanitize, DIMO_SANITIZE_SCHEMA)
  .use(rehypeListMetadata)
  .use(rehypeSanitizeDataUrls);

const rawHtmlProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkPreserveCodeMeta)
  .use(remarkFilterRawHtml, { rawHtml: true })
  .use(remarkGithubAlerts)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, DIMO_SANITIZE_SCHEMA)
  .use(rehypeListMetadata)
  .use(rehypeSanitizeDataUrls);

/**
 * Extracts an optional display title/filename from a fenced code info meta string
 * (e.g. `title="src/app.ts"`, `file='main.rs'`, or bare `src/app.ts`).
 */
export function extractFenceTitle(meta?: string | null): string | undefined {
  if (!meta) return undefined;
  const trimmed = meta.trim();
  if (!trimmed) return undefined;

  const kvMatch = trimmed.match(
    /(?:^|\s)(?:title|file|filename|path)=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i
  );
  if (kvMatch) {
    return (kvMatch[1] ?? kvMatch[2] ?? kvMatch[3])?.trim() || undefined;
  }

  const firstToken = trimmed.split(/\s+/)[0] ?? '';
  if (
    firstToken &&
    !firstToken.startsWith('{') &&
    !firstToken.includes('=') &&
    (/[/.\\]/.test(firstToken) || firstToken.includes(':'))
  ) {
    return firstToken;
  }

  return undefined;
}

export type RenderMarkdownOptions = {
  rawHtml?: boolean;
  inlineTokens?: readonly InlineTokenMatcher[];
  components?: Partial<Components>;
};

export function renderMarkdownToReactElement(
  markdown: string,
  options: RenderMarkdownOptions = {}
): ReactElement {
  const normalized = normalizeOverIndentedNestedLists(markdown);
  const useRawHtml = options.rawHtml !== false && normalized.includes('<');
  const processor = useRawHtml ? rawHtmlProcessor : plainProcessor;

  const mdast = processor.parse(normalized);
  const hast = processor.runSync(mdast) as HastRoot;

  if (options.inlineTokens && options.inlineTokens.length > 0) {
    applyHastInlineTokens(hast, options.inlineTokens);
  }

  return toJsxRuntime(hast, {
    Fragment,
    jsx,
    jsxs,
    components: options.components,
  }) as ReactElement;
}
