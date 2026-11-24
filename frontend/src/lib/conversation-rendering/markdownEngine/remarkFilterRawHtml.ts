import type { Html, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

import { RAW_HTML_ALLOWED_TAGS } from '../rawHtml';

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const HTML_TAG_REGEX = /<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)[^>]*>/g;

function escapeTagAngleBrackets(tag: string): string {
  return tag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem']);

function convertHtmlNodeToText(
  node: Html,
  value: string,
  parentType?: string
): void {
  if (parentType && BLOCK_PARENTS.has(parentType)) {
    const mutable = node as unknown as {
      type: string;
      value?: string;
      children?: Text[];
    };
    mutable.type = 'paragraph';
    delete mutable.value;
    mutable.children = [{ type: 'text', value }];
    return;
  }
  const mutable = node as unknown as Text;
  mutable.type = 'text';
  mutable.value = value;
}

/**
 * Remark plugin enforcing Dimo's raw HTML safety contract:
 * - When `rawHtml` is `false`, all HTML nodes become visible literal text.
 * - When `rawHtml` is `true`, HTML tags outside `RAW_HTML_ALLOWED_TAGS`
 *   (e.g. `<script>`, `<system-reminder>`) are preserved as visible literal text
 *   rather than executed or silently deleted.
 */
export function remarkFilterRawHtml(options: { rawHtml: boolean }) {
  return (tree: Root) => {
    visit(tree, 'html', (node: Html, _index, parent) => {
      const parentType = parent?.type;
      if (!options.rawHtml) {
        convertHtmlNodeToText(node, node.value, parentType);
        return;
      }

      const strippedComments = node.value.replace(HTML_COMMENT_REGEX, '');
      if (strippedComments.trim().length === 0) {
        node.value = '';
        return;
      }

      let allowedCount = 0;
      let disallowedCount = 0;
      HTML_TAG_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = HTML_TAG_REGEX.exec(strippedComments)) !== null) {
        const tagName = (match[1] ?? '').toLowerCase();
        if (RAW_HTML_ALLOWED_TAGS.has(tagName)) {
          allowedCount += 1;
        } else {
          disallowedCount += 1;
        }
      }

      if (allowedCount === 0) {
        // Pure disallowed tags (e.g. `<script>`, `<system-reminder>`) stay literal text.
        convertHtmlNodeToText(node, node.value, parentType);
        return;
      }

      if (disallowedCount > 0) {
        // Mixed chunk: keep allowed tags as HTML and escape disallowed tags so they display literally.
        HTML_TAG_REGEX.lastIndex = 0;
        node.value = strippedComments.replace(
          HTML_TAG_REGEX,
          (fullTag: string, tagName: string) =>
            RAW_HTML_ALLOWED_TAGS.has(tagName.toLowerCase())
              ? fullTag
              : escapeTagAngleBrackets(fullTag)
        );
        return;
      }

      node.value = strippedComments;
    });
  };
}
