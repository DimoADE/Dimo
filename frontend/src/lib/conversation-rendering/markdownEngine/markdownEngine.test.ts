import { describe, expect, it } from 'vitest';

import {
  buildBasenameDisambiguationMap,
  extractFileLocation,
  formatCompactFileLinkLabel,
  formatLineLocationSuffix,
} from '@/components/NormalizedConversation/fileLinkLabel';
import {
  formatMatrixAsDelimited,
  formatMatrixAsMarkdown,
} from '@/components/NormalizedConversation/MarkdownTable';
import {
  extractYamlFrontmatter,
  toggleMarkdownTaskCheckbox,
} from '../markdownFrontmatterAndTasks';
import { extractFenceTitle } from './markdownProcessor';
import { normalizeOverIndentedNestedLists } from './remarkNormalizeListIndentation';

describe('fileLinkLabel helpers', () => {
  it('parses hash and colon line/range/column locations', () => {
    expect(extractFileLocation('src/a.rs#L22')).toEqual({ line: 22, column: 1 });
    expect(extractFileLocation('src/a.rs#L22-L40')).toEqual({
      line: 22,
      column: 1,
      endLine: 40,
    });
    expect(extractFileLocation('src/a.rs#L22C5-L40C10')).toEqual({
      line: 22,
      column: 5,
      endLine: 40,
    });
    expect(extractFileLocation('C:/repo/src/a.rs:12:4')).toEqual({
      line: 12,
      column: 4,
    });
    expect(extractFileLocation('src/a.rs:52-120')).toEqual({
      line: 52,
      column: 1,
      endLine: 120,
    });
    expect(extractFileLocation('C:/repo/src/a.rs')).toBeNull();
  });

  it('formats disambiguated compact file labels with line suffixes', () => {
    const map = buildBasenameDisambiguationMap([
      'crates/a/src/turn/mod.rs',
      'crates/b/src/chat/mod.rs',
      'crates/c/src/unique.rs',
    ]);

    expect(map.get('crates/a/src/turn/mod.rs')).toBe('turn');
    expect(map.get('crates/b/src/chat/mod.rs')).toBe('chat');
    expect(map.has('crates/c/src/unique.rs')).toBe(false);

    expect(
      formatCompactFileLinkLabel({
        displayPath: 'crates/a/src/turn/mod.rs',
        nodeType: 'file',
        disambiguationSuffix: map.get('crates/a/src/turn/mod.rs'),
        location: { line: 52, column: 1, endLine: 120 },
      })
    ).toBe('mod.rs · turn · L52–120');
    expect(formatLineLocationSuffix({ line: 22, column: 1 })).toBe('L22');
  });
});

describe('markdownFrontmatterAndTasks', () => {
  it('extracts leading YAML frontmatter without affecting horizontal rules', () => {
    const doc = '---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body';
    expect(extractYamlFrontmatter(doc)).toEqual({
      frontmatter: 'title: Hello\ntags: [a, b]',
      body: '\n# Body',
    });

    const hrDoc = '# Body\n\n---\n\nFooter';
    expect(extractYamlFrontmatter(hrDoc)).toEqual({
      frontmatter: null,
      body: hrDoc,
    });
  });

  it('toggles task checkboxes outside fenced code blocks and skips frontmatter', () => {
    const doc = [
      '---',
      'note: "- [ ] not a task"',
      '---',
      '',
      '- [ ] First',
      '```md',
      '- [ ] Inside code fence',
      '```',
      '- [x] Second',
      '> - [ ] Quoted third',
    ].join('\n');

    const toggledFirst = toggleMarkdownTaskCheckbox(doc, 0, true);
    expect(toggledFirst).toContain('- [x] First');
    expect(toggledFirst).toContain('- [ ] Inside code fence');

    const toggledSecond = toggleMarkdownTaskCheckbox(doc, 1, false);
    expect(toggledSecond).toContain('- [ ] Second');

    const toggledThird = toggleMarkdownTaskCheckbox(doc, 2, true);
    expect(toggledThird).toContain('> - [x] Quoted third');
  });
});

describe('markdownEngine plugins & table serialization', () => {
  it('normalizes nested list indentation while leaving fenced code intact', () => {
    const input = [
      '1. Parent',
      '  - Two-space nested',
      '        - Eight-space nested',
      '```',
      '        - untouched fence',
      '```',
      '2. Sibling',
    ].join('\n');

    const normalized = normalizeOverIndentedNestedLists(input);
    expect(normalized).toContain('   - Two-space nested');
    expect(normalized).toContain('     - Eight-space nested');
    expect(normalized).toContain('        - untouched fence');
  });

  it('extracts fence titles from key-value and bare filename meta', () => {
    expect(extractFenceTitle('title="src/app.ts"')).toBe('src/app.ts');
    expect(extractFenceTitle("file='main.rs'")).toBe('main.rs');
    expect(extractFenceTitle('crates/server/src/lib.rs')).toBe(
      'crates/server/src/lib.rs'
    );
    expect(extractFenceTitle('{1-3}')).toBeUndefined();
  });

  it('serializes table matrices to Markdown, CSV, and TSV', () => {
    const matrix = [
      ['Name', 'Value'],
      ['a|b', '1, "2"'],
    ];

    expect(formatMatrixAsMarkdown(matrix)).toBe(
      '| Name | Value |\n| --- | --- |\n| a\\|b | 1, "2" |'
    );
    expect(formatMatrixAsDelimited(matrix, ',')).toBe(
      'Name,Value\na|b,"1, ""2"""'
    );
    expect(formatMatrixAsDelimited(matrix, '\t')).toBe(
      'Name\tValue\na|b\t1, "2"'
    );
  });
});
