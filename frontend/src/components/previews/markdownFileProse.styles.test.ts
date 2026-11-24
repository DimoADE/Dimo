import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(
  process.cwd(),
  'src/components/previews/markdownFileProse.css'
);

function rules(): Array<{
  selector: string;
  decls: Record<string, string>;
}> {
  const css = readFileSync(STYLESHEET, 'utf8');
  const result: Array<{ selector: string; decls: Record<string, string> }> = [];
  parse(css).walkRules((rule: Rule) => {
    const decls: Record<string, string> = {};
    rule.walkDecls((declaration) => {
      decls[declaration.prop] = declaration.value;
    });
    result.push({
      selector: rule.selector.replace(/\s+/g, ' ').trim(),
      decls,
    });
  });
  return result;
}

function ruleIncluding(...parts: string[]) {
  const found = rules().find((rule) =>
    parts.every((part) => rule.selector.includes(part))
  );
  expect(found, `missing rule with ${parts.join(' + ')}`).toBeTruthy();
  return found!;
}

describe('markdown file prose chrome', () => {
  it('matches upgraded conversation markdown body metrics on Preview and RichText', () => {
    const root = ruleIncluding('.markdown-file-prose', '[contenteditable]');
    expect(root.decls['font-size']).toBe('14px');
    expect(root.decls['line-height']).toBe('1.625');

    const body = ruleIncluding(
      '.markdown-file-prose',
      ":is(p, li, [role='paragraph'])"
    );
    expect(body.decls['font-size']).toBe('14px');
    expect(body.decls['line-height']).toBe('1.625');
  });

  it('applies a semantic heading hierarchy across h1 through h6', () => {
    const headings = ruleIncluding(
      '.markdown-file-prose',
      ':is(h1, h2, h3, h4, h5, h6)'
    );
    expect(headings.decls['font-weight']).toBe('600');

    const h1 = ruleIncluding('.markdown-file-prose h1:');
    const h2 = ruleIncluding('.markdown-file-prose h2:');
    const h3 = ruleIncluding('.markdown-file-prose h3:');
    expect(h1.decls['font-size']).toBe('1.25rem');
    expect(h2.decls['font-size']).toBe('1.125rem');
    expect(h3.decls['font-size']).toBe('1rem');
  });

  it('uses crisp 4px inline code chips and minimalist row-only tables', () => {
    const inlineCode = ruleIncluding('.markdown-file-prose', ':not(pre) > code');
    expect(inlineCode.decls['border-radius']).toBe('var(--radius-inline-code)');

    const table = ruleIncluding('.markdown-file-prose table:');
    expect(table.decls['border-collapse']).toBe('collapse');
    expect(table.decls['border']).toBe('none');
  });

  it('indents native RichText lists so outside markers stay in the tab', () => {
    const lists = ruleIncluding(
      '.markdown-file-prose',
      '[contenteditable]',
      'ul'
    );
    expect(lists.decls['padding-inline-start']).toBe('var(--spacing-6, 24px)');
    expect(lists.decls['padding-left']).toBe('var(--spacing-6, 24px)');
    expect(lists.decls['list-style-position']).toBe('outside');
  });
});
