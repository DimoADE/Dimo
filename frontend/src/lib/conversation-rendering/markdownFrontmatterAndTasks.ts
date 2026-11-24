import { splitFencedCodeSegments } from './markdownFences';

export type ExtractedFrontmatter = {
  frontmatter: string | null;
  body: string;
};

const YAML_FRONTMATTER_REGEX =
  /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Strips leading YAML frontmatter (`---\n...\n---`) for rendered Markdown file
 * previews so frontmatter is not rendered as a heading or horizontal rule.
 */
export function extractYamlFrontmatter(source: string): ExtractedFrontmatter {
  if (!source.startsWith('---') && !source.startsWith('\uFEFF---')) {
    return { frontmatter: null, body: source };
  }

  const match = source.match(YAML_FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: null, body: source };
  }

  const frontmatter = (match[1] ?? '').trim();
  const body = source.slice(match[0].length);
  return {
    frontmatter: frontmatter.length > 0 ? frontmatter : null,
    body,
  };
}

const TASK_LIST_LINE_REGEX =
  /^((?:[ \t]*>[ \t]*)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\](?:[ \t]+|$).*)$/;

/**
 * Toggles the N-th GFM task-list checkbox (0-indexed) outside fenced code
 * blocks in a raw Markdown document.
 */
export function toggleMarkdownTaskCheckbox(
  source: string,
  targetTaskIndex: number,
  checked: boolean
): string {
  if (targetTaskIndex < 0) return source;

  const frontmatterMatch =
    source.startsWith('---') || source.startsWith('\uFEFF---')
      ? source.match(YAML_FRONTMATTER_REGEX)
      : null;
  const prefix = frontmatterMatch ? frontmatterMatch[0] : '';
  const body = prefix ? source.slice(prefix.length) : source;

  let currentTaskIndex = 0;
  let updated = false;

  const segments = splitFencedCodeSegments(body);
  const nextSegments = segments.map((segment) => {
    if (segment.kind !== 'text' || updated) {
      return segment.text;
    }

    const lines = segment.text.split('\n');
    const nextLines = lines.map((line) => {
      if (updated) return line;
      const match = line.match(TASK_LIST_LINE_REGEX);
      if (!match) return line;

      const isTarget = currentTaskIndex === targetTaskIndex;
      currentTaskIndex += 1;
      if (!isTarget) return line;

      updated = true;
      const nextMark = checked ? 'x' : ' ';
      return `${match[1]}${nextMark}${match[3]}`;
    });

    return nextLines.join('\n');
  });

  return updated ? `${prefix}${nextSegments.join('')}` : source;
}
