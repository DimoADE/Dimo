import type { Blockquote, Paragraph, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

export type MarkdownAlertKind =
  | 'note'
  | 'tip'
  | 'important'
  | 'warning'
  | 'caution';

const GITHUB_ALERT_REGEX =
  /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\r\n]+))?(?:\r?\n|$)/i;

/**
 * Remark plugin transforming GitHub-flavored alert blockquotes:
 * `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`
 * (with optional inline custom title) into `<div data-markdown-alert="...">`.
 */
export function remarkGithubAlerts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const firstChild = node.children[0];
      if (!firstChild || firstChild.type !== 'paragraph') {
        return;
      }

      const firstInline = firstChild.children[0];
      if (!firstInline || firstInline.type !== 'text') {
        return;
      }

      const match = firstInline.value.match(GITHUB_ALERT_REGEX);
      if (!match) {
        return;
      }

      const kind = (match[1] ?? 'note').toLowerCase() as MarkdownAlertKind;
      const customTitle = match[2]?.trim() || undefined;
      const remainingText = firstInline.value.slice(match[0].length);

      if (remainingText.length > 0) {
        (firstInline as Text).value = remainingText;
      } else {
        firstChild.children.shift();
        if (firstChild.children[0]?.type === 'break') {
          firstChild.children.shift();
        }
      }

      if (firstChild.children.length === 0) {
        node.children.shift();
      } else if (
        firstChild.children[0]?.type === 'text' &&
        (firstChild.children[0] as Text).value.startsWith('\n')
      ) {
        (firstChild.children[0] as Text).value = (
          firstChild.children[0] as Text
        ).value.replace(/^\r?\n/, '');
      }

      const paragraphCheck = node.children[0] as Paragraph | undefined;
      if (
        paragraphCheck &&
        paragraphCheck.type === 'paragraph' &&
        paragraphCheck.children.length === 0
      ) {
        node.children.shift();
      }

      const hProperties: Record<string, string> = {
        dataMarkdownAlert: kind,
      };
      if (customTitle) {
        hProperties.dataMarkdownAlertTitle = customTitle;
      }

      node.data = {
        ...node.data,
        hName: 'div',
        hProperties,
      };
    });
  };
}
