import type { Element, ElementContent, Root, Text } from 'hast';

export type InlineTokenMatcher = {
  kind: string;
  pattern: RegExp;
};

const SKIP_PARENT_TAGS = new Set(['code', 'pre', 'script', 'style']);

function splitTextByMatchers(
  value: string,
  matchers: readonly InlineTokenMatcher[]
): ElementContent[] | null {
  type MatchHit = {
    start: number;
    end: number;
    kind: string;
    tokenIndex: string;
  };

  const hits: MatchHit[] = [];
  for (const matcher of matchers) {
    const flags = matcher.pattern.flags.includes('g')
      ? matcher.pattern.flags
      : `${matcher.pattern.flags}g`;
    const regex = new RegExp(matcher.pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: matcher.kind,
        tokenIndex: match[1] ?? '',
      });
    }
  }

  if (hits.length === 0) {
    return null;
  }

  hits.sort((a, b) => a.start - b.start || b.end - a.end);

  const output: ElementContent[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) {
      output.push({ type: 'text', value: value.slice(cursor, hit.start) });
    }
    output.push({
      type: 'element',
      tagName: 'span',
      properties: {
        dataMdToken: hit.kind,
        dataMdTokenIndex: hit.tokenIndex,
      },
      children: [],
    });
    cursor = hit.end;
  }

  if (cursor < value.length) {
    output.push({ type: 'text', value: value.slice(cursor) });
  }

  return output;
}

function walkNode(
  node: Root | Element,
  matchers: readonly InlineTokenMatcher[]
): void {
  if (node.type === 'element' && SKIP_PARENT_TAGS.has(node.tagName)) {
    return;
  }

  const nextChildren: ElementContent[] = [];
  let mutated = false;

  for (const child of node.children) {
    if (child.type === 'text') {
      const replacement = splitTextByMatchers((child as Text).value, matchers);
      if (replacement) {
        nextChildren.push(...replacement);
        mutated = true;
      } else {
        nextChildren.push(child);
      }
      continue;
    }

    if (child.type === 'element') {
      walkNode(child, matchers);
    }
    nextChildren.push(child as ElementContent);
  }

  if (mutated) {
    node.children = nextChildren;
  }
}

/**
 * Replaces Dimo placeholder tokens (math, member mentions, composer tokens)
 * inside HAST text nodes outside `code`/`pre` with `<span data-md-token="..." />`
 * islands so React components can render them cleanly.
 */
export function applyHastInlineTokens(
  tree: Root,
  matchers: readonly InlineTokenMatcher[]
): void {
  if (matchers.length === 0) return;
  walkNode(tree, matchers);
}
