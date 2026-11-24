import { splitFencedCodeSegments } from '../markdownFences';
import { buildBasenameDisambiguationMap } from '@/components/NormalizedConversation/fileLinkLabel';
import {
  resolveMarkdownInlineResource,
  resolveMarkdownWorkspacePathTarget,
} from '@/components/NormalizedConversation/MarkdownResourceLink';

const MARKDOWN_LINK_REGEX = /(?<!!)\[([^\]\n]+)\]\(([^)\n]*)\)/g;
const INLINE_CODE_REGEX = /`([^`\n]+)`/g;

/**
 * Scans a Markdown document outside fenced code blocks to collect all resolved
 * workspace file display paths and build a basename disambiguation map
 * (only populated for basenames that appear in multiple directories).
 */
export function buildMessageFileDisambiguationMap(
  markdown: string,
  workspacePath?: string | null
): ReadonlyMap<string, string> | undefined {
  if (!markdown || (!markdown.includes('/') && !markdown.includes('\\'))) {
    return undefined;
  }

  const displayPaths: string[] = [];
  const segments = splitFencedCodeSegments(markdown);

  for (const segment of segments) {
    if (segment.kind !== 'text') continue;
    const text = segment.text;

    if (text.includes('](')) {
      MARKDOWN_LINK_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MARKDOWN_LINK_REGEX.exec(text)) !== null) {
        const label = match[1] ?? '';
        const href = match[2] ?? '';
        const target = resolveMarkdownWorkspacePathTarget(
          href || undefined,
          label,
          workspacePath
        );
        if (target?.nodeType === 'file') {
          displayPaths.push(target.displayPath);
        }
      }
    }

    if (text.includes('`')) {
      INLINE_CODE_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = INLINE_CODE_REGEX.exec(text)) !== null) {
        const codeText = (match[1] ?? '').trim();
        if (!codeText.includes('/') && !codeText.includes('\\')) continue;
        const resource = resolveMarkdownInlineResource(codeText, workspacePath);
        if (resource?.pathTarget?.nodeType === 'file') {
          displayPaths.push(resource.pathTarget.displayPath);
        }
      }
    }
  }

  if (displayPaths.length < 2) {
    return undefined;
  }

  const map = buildBasenameDisambiguationMap(displayPaths);
  return map.size > 0 ? map : undefined;
}
