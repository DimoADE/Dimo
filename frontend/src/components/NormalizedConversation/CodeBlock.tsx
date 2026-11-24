import { memo, useCallback, useState } from 'react';
import { Check, Copy, WrapText } from 'lucide-react';
import FileIcon from '@/components/FileIcon';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import {
  getShikiTokenStyle,
  normalizeShikiLanguage,
  useShikiTokens,
  type ShikiTokenLines,
} from '@/utils/shikiHighlighter';

export type CodeBlockHighlightState = 'deferred' | 'highlighted' | 'plain';

type CodeBlockProps = {
  className?: string;
  value: string;
  title?: string;
  isStreaming?: boolean;
  deferHighlight?: boolean;
};

const LANGUAGE_SYNTHETIC_FILENAMES: Record<string, string> = {
  bash: 'script.sh',
  c: 'main.c',
  cpp: 'main.cpp',
  cs: 'Program.cs',
  csharp: 'Program.cs',
  css: 'styles.css',
  diff: 'changes.diff',
  dockerfile: 'Dockerfile',
  go: 'main.go',
  graphql: 'schema.graphql',
  html: 'index.html',
  java: 'Main.java',
  javascript: 'index.js',
  js: 'index.js',
  json: 'data.json',
  jsonc: 'config.jsonc',
  jsx: 'App.jsx',
  kotlin: 'Main.kt',
  kt: 'Main.kt',
  markdown: 'README.md',
  md: 'README.md',
  php: 'index.php',
  powershell: 'script.ps1',
  ps1: 'script.ps1',
  py: 'main.py',
  python: 'main.py',
  rb: 'main.rb',
  rs: 'main.rs',
  ruby: 'main.rb',
  rust: 'main.rs',
  scss: 'styles.scss',
  sh: 'script.sh',
  shell: 'script.sh',
  sql: 'query.sql',
  svelte: 'App.svelte',
  swift: 'main.swift',
  toml: 'Cargo.toml',
  ts: 'index.ts',
  tsx: 'App.tsx',
  typescript: 'index.ts',
  vue: 'App.vue',
  xml: 'data.xml',
  yaml: 'config.yaml',
  yml: 'config.yml',
  zsh: 'script.sh',
};

export function extractLanguageTag(className?: string): string | null {
  if (!className) return null;
  const match = className.match(/language-([\w-]+)/i);
  return match ? match[1] : null;
}

function syntheticFileNameForLanguage(
  languageTag: string | null,
  title?: string
): string | null {
  const trimmedTitle = title?.trim();
  if (trimmedTitle && /\.[a-z0-9]{1,12}$/i.test(trimmedTitle)) {
    return trimmedTitle;
  }
  if (!languageTag) return null;
  return LANGUAGE_SYNTHETIC_FILENAMES[languageTag.toLowerCase()] ?? null;
}

function hasHighlightedTokens(tokens: ShikiTokenLines): boolean {
  return tokens.some((line) =>
    line.some(
      (token) =>
        Boolean(token.variants.light?.color) ||
        Boolean(token.variants.dark?.color) ||
        token.variants.light?.fontStyle !== undefined ||
        token.variants.dark?.fontStyle !== undefined
    )
  );
}

function resolveHighlightState(
  deferHighlight: boolean,
  tokens: ShikiTokenLines
): CodeBlockHighlightState {
  if (deferHighlight) return 'deferred';
  return hasHighlightedTokens(tokens) ? 'highlighted' : 'plain';
}

function TokenizedCode({ tokens }: { tokens: ShikiTokenLines }) {
  return (
    <>
      {tokens.map((line, lineIndex) => (
        <span className="conv-md-codeblock-line" key={lineIndex}>
          {line.map((token, tokenIndex) => (
            <span
              className="conv-md-token"
              key={`${lineIndex}-${token.offset}-${tokenIndex}`}
              style={getShikiTokenStyle(token)}
            >
              {token.content}
            </span>
          ))}
        </span>
      ))}
    </>
  );
}

export const CompactCodeBlock = memo(function CompactCodeBlock({
  className,
  value,
  deferHighlight = false,
}: CodeBlockProps) {
  const language = normalizeShikiLanguage(extractLanguageTag(className));
  const tokens = useShikiTokens(
    deferHighlight ? '' : value,
    deferHighlight ? 'text' : language
  );
  const highlightState = resolveHighlightState(deferHighlight, tokens);

  return (
    <pre
      className="conv-md-codeblock-single"
      data-highlight-state={highlightState}
    >
      <code className={className}>
        {deferHighlight ? value : <TokenizedCode tokens={tokens} />}
      </code>
    </pre>
  );
});

export const CodeBlock = memo(function CodeBlock({
  className,
  value,
  title,
  isStreaming = false,
  deferHighlight = false,
}: CodeBlockProps) {
  const [copied, triggerCopied] = useTemporaryFlag(1200);
  const [wrapped, setWrapped] = useState(false);
  const languageTag = extractLanguageTag(className);
  const language = normalizeShikiLanguage(languageTag);
  const tokens = useShikiTokens(
    deferHighlight ? '' : value,
    deferHighlight ? 'text' : language,
    {
      incremental: isStreaming && !deferHighlight,
    }
  );
  const languageLabel = languageTag?.trim() || 'text';
  const iconFileName = syntheticFileNameForLanguage(languageTag, title);
  const highlightState = resolveHighlightState(deferHighlight, tokens);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      triggerCopied();
    } catch {
      // Clipboard access depends on the host WebView permission state.
    }
  }, [triggerCopied, value]);

  const toggleWrap = useCallback(() => {
    setWrapped((prev) => !prev);
  }, []);

  return (
    <div
      className={`conv-md-codeblock${wrapped ? ' is-wrapped' : ''}`}
      data-highlight-state={highlightState}
      data-language={languageTag ?? undefined}
    >
      <div className="conv-md-codeblock-header">
        <div className="conv-md-codeblock-meta">
          {iconFileName ? (
            <span className="conv-md-codeblock-icon" aria-hidden="true">
              <FileIcon filePath={iconFileName} isFolder={false} />
            </span>
          ) : null}
          <span className="conv-md-codeblock-language">{languageLabel}</span>
          {title ? (
            <span className="conv-md-codeblock-title" title={title}>
              {title}
            </span>
          ) : null}
        </div>
        <div className="conv-md-codeblock-actions">
          <button
            type="button"
            className={`conv-md-codeblock-action${wrapped ? ' is-active' : ''}`}
            onClick={toggleWrap}
            title={wrapped ? '取消自动换行' : '自动换行'}
            aria-label={wrapped ? '取消自动换行' : '自动换行'}
            aria-pressed={wrapped}
          >
            <WrapText className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={`conv-md-codeblock-copy${copied ? ' is-copied' : ''}`}
            onClick={handleCopy}
            title={copied ? '已复制' : '复制代码'}
            aria-label={copied ? '已复制' : '复制代码'}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
      <pre>
        <code className={className}>
          {deferHighlight ? value : <TokenizedCode tokens={tokens} />}
        </code>
      </pre>
    </div>
  );
});
