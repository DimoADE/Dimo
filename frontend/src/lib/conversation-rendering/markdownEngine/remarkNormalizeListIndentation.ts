import { splitFencedCodeSegments } from '../markdownFences';

const LIST_ITEM_LINE_REGEX = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;

type ListStackFrame = {
  markerIndent: number;
  contentIndent: number;
};

function measureIndent(prefix: string): number {
  let width = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] === '\t') {
      width += 4 - (width % 4);
    } else {
      width += 1;
    }
  }
  return width;
}

function normalizeListIndentationInText(text: string): string {
  if (!text.includes('\n')) return text;

  const lines = text.split('\n');
  const stack: ListStackFrame[] = [];
  let blankRun = 0;
  let changed = false;

  const normalizedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      blankRun += 1;
      if (blankRun >= 2) {
        stack.length = 0;
      }
      return line;
    }

    const listMatch = line.match(LIST_ITEM_LINE_REGEX);
    if (!listMatch) {
      const leadingSpaces = measureIndent(line.match(/^[ \t]*/)?.[0] ?? '');
      while (
        stack.length > 0 &&
        leadingSpaces < stack[stack.length - 1]!.contentIndent
      ) {
        stack.pop();
      }
      blankRun = 0;
      return line;
    }

    blankRun = 0;
    const rawIndent = listMatch[1] ?? '';
    const marker = listMatch[2] ?? '-';
    const gap = listMatch[3] ?? ' ';
    const rest = listMatch[4] ?? '';
    const indent = measureIndent(rawIndent);

    while (
      stack.length > 0 &&
      indent <= stack[stack.length - 1]!.markerIndent
    ) {
      stack.pop();
    }

    if (stack.length === 0) {
      // Do not rewrite top-level 4+ space indented code blocks.
      if (indent < 4) {
        stack.push({
          markerIndent: indent,
          contentIndent: indent + marker.length + Math.min(gap.length, 4),
        });
      }
      return line;
    }

    const parent = stack[stack.length - 1]!;
    let targetIndent = indent;

    // LLMs often indent nested bullets under `1. ` by 2 spaces (< contentIndent 3)
    // or over-indent nested items by 4+ spaces past contentIndent (turning them into code blocks).
    if (indent < parent.contentIndent) {
      targetIndent = parent.contentIndent;
    } else if (indent >= parent.contentIndent + 4) {
      targetIndent = parent.contentIndent;
    }

    const clampedGap = gap.length > 4 ? ' ' : gap;
    stack.push({
      markerIndent: targetIndent,
      contentIndent: targetIndent + marker.length + clampedGap.length,
    });

    if (targetIndent !== indent || clampedGap !== gap) {
      changed = true;
      return `${' '.repeat(targetIndent)}${marker}${clampedGap}${rest}`;
    }

    return line;
  });

  return changed ? normalizedLines.join('\n') : text;
}

/**
 * Normalizes LLM-produced nested list indentation outside fenced code blocks so
 * CommonMark preserves list hierarchy instead of flattening sub-lists or turning
 * over-indented sub-items into indented code blocks.
 */
export function normalizeOverIndentedNestedLists(markdown: string): string {
  if (!markdown || !markdown.includes('\n')) {
    return markdown;
  }

  return splitFencedCodeSegments(markdown)
    .map((segment) =>
      segment.kind === 'text'
        ? normalizeListIndentationInText(segment.text)
        : segment.text
    )
    .join('');
}
