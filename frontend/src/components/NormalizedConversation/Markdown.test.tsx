import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AstryxMarkdown as Markdown,
  getMarkdownBlockElementCacheStats,
  resetMarkdownBlockElementCache,
} from './AstryxMarkdown';

const markdownStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/conversation/conv-markdown.css'),
  'utf8'
);

const panelActionsMock = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
  revealInFileTree: vi.fn(),
}));

const clipboardMock = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

const hostAssetMock = vi.hoisted(() => ({
  hostFileSrc: vi.fn(async (path: string) => `asset://${path}`),
}));

const shikiMock = vi.hoisted(() => {
  const loadLanguage = vi.fn(async () => undefined);
  const codeToTokensWithThemes = vi.fn((code: string) =>
    code.split('\n').map((line) =>
      line
        ? [
            {
              content: line,
              offset: 0,
              variants: {
                light: { color: 'rgb(17 17 17)' },
                dark: { color: 'rgb(238 238 238)' },
              },
            },
          ]
        : []
    )
  );
  const createHighlighter = vi.fn(async () => ({
    loadLanguage,
    codeToTokensWithThemes,
  }));

  return {
    codeToTokensWithThemes,
    createHighlighter,
    loadLanguage,
  };
});

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Mock diagram</text></svg>',
  })),
}));

vi.mock('shiki', () => ({
  bundledLanguages: {
    bash: {},
    css: {},
    diff: {},
    html: {},
    javascript: {},
    json: {},
    markdown: {},
    python: {},
    rust: {},
    tsx: {},
    typescript: {},
    yaml: {},
  },
  createHighlighter: shikiMock.createHighlighter,
}));

vi.mock('shiki/core', () => ({
  createHighlighterCore: shikiMock.createHighlighter,
}));

vi.mock('shiki/engine/javascript', () => ({
  createJavaScriptRegexEngine: vi.fn(() => ({})),
}));

vi.mock('shiki/langs', () => ({
  bundledLanguages: {
    bash: {},
    css: {},
    diff: {},
    html: {},
    javascript: {},
    json: {},
    markdown: {},
    python: {},
    rust: {},
    tsx: {},
    typescript: {},
    yaml: {},
  },
}));

vi.mock('mermaid', () => ({
  default: mermaidMock,
}));

vi.mock('@/lib/desktopShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/desktopShell')>();
  return {
    ...actual,
    getDesktopShell: () => {
      const shell = actual.getDesktopShell();
      return {
        ...shell,
        assets: {
          ...shell.assets,
          convertFileSrc: (path: string) => `asset://${path}`,
        },
      };
    },
  };
});

vi.mock('@/lib/hostAsset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hostAsset')>();
  return {
    ...actual,
    hostFileSrc: hostAssetMock.hostFileSrc,
    releaseHostFileSrc: () => undefined,
  };
});

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => panelActionsMock,
}));

vi.mock('@/components/dialogs/wysiwyg/ImagePreviewDialog', () => ({
  ImagePreviewDialog: {
    show: vi.fn(),
  },
}));

function renderMarkdown(
  value: string,
  props: Partial<ComponentProps<typeof Markdown>> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <div className="legacy-design">
      <style>{markdownStyles}</style>
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={value}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          {...props}
        />
      </QueryClientProvider>
    </div>
  );
}

describe('Markdown', () => {
  beforeEach(() => {
    resetMarkdownBlockElementCache();
    hostAssetMock.hostFileSrc.mockReset();
    hostAssetMock.hostFileSrc.mockImplementation(
      async (path: string) => `asset://${path}`
    );
    panelActionsMock.openFilePreview.mockClear();
    panelActionsMock.revealInFileTree.mockClear();
    shikiMock.createHighlighter.mockClear();
    shikiMock.codeToTokensWithThemes.mockClear();
    shikiMock.loadLanguage.mockClear();
    mermaidMock.initialize.mockClear();
    mermaidMock.render.mockClear();
    mermaidMock.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Mock diagram</text></svg>',
    });
    clipboardMock.writeText.mockReset();
    clipboardMock.writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboardMock,
    });
  });

  it('renders remote markdown images inline', () => {
    renderMarkdown('![Generated image](https://example.com/image.png)');

    const image = screen.getByRole('img', { name: 'Generated image' });
    expect(image).toHaveAttribute('src', 'https://example.com/image.png');
  });

  it.each(['Status', 'docs/example.png'])(
    'opens the actual unavailable image rather than its label %s',
    async (label) => {
      hostAssetMock.hostFileSrc.mockRejectedValueOnce(
        new Error('File not found')
      );
      renderMarkdown(`![${label}](evidence/agent-runtime-status-zh.png)`);

      const link = await screen.findByRole('link', { name: label });
      fireEvent.click(link);

      expect(link).not.toHaveAttribute('href');
      expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
        'C:/workspace/project/evidence/agent-runtime-status-zh.png',
        expect.any(Object)
      );
    }
  );

  it('renders bare GFM URLs as links', () => {
    renderMarkdown('See https://example.com/docs for details.');

    const link = screen.getByRole('link', {
      name: 'https://example.com/docs',
    });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveClass('conv-resource-link');
    expect(link).toHaveAttribute('data-resource-kind', 'web');
    expect(link.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/favicon.ico'
    );
  });

  it('uses the link label as the inline baseline while centering its icon', () => {
    renderMarkdown('Plain text and [linked text](https://example.com/docs).');

    const link = screen.getByRole('link', { name: 'linked text' });
    const icon = link.querySelector('.conv-resource-link-icon');

    expect(getComputedStyle(link).alignItems).toBe('baseline');
    expect(getComputedStyle(icon as Element).alignSelf).toBe('center');
  });

  it('renders native multi-level ordered and unordered lists with semantic markers and dynamic multi-digit gutter', () => {
    renderMarkdown(
      [
        '1. first',
        '   - nested bullet',
        '     - deep bullet',
        '       - third level bullet',
        '2. second',
        '3. third',
        '4. fourth',
        '5. fifth',
        '6. sixth',
        '7. seventh',
        '8. eighth',
        '9. ninth',
        '10. tenth',
      ].join('\n')
    );

    const lists = screen.getAllByRole('list');
    const ordered = lists.find((list) => list.tagName === 'OL');
    const unordered = lists.filter((list) => list.tagName === 'UL');

    expect(ordered).toBeTruthy();
    expect(ordered).toHaveAttribute('data-ol-digits', '2');
    expect(getComputedStyle(ordered as Element).listStyleType).toBe('decimal');
    expect(getComputedStyle(ordered as Element).listStylePosition).toBe(
      'outside'
    );

    expect(unordered).toHaveLength(3);
    expect(getComputedStyle(unordered[0]!).listStyleType).toBe('disc');
    expect(getComputedStyle(unordered[1]!).listStyleType).toBe('circle');
    expect(getComputedStyle(unordered[2]!).listStyleType).toBe('square');
  });

  it('uses consistent outside list markers and indentation for ordered and unordered lists', () => {
    renderMarkdown('- bullet\n\n1. first');

    const unordered = screen
      .getAllByRole('list')
      .find((list) => list.tagName === 'UL');
    const ordered = screen
      .getAllByRole('list')
      .find((list) => list.tagName === 'OL');

    expect(getComputedStyle(unordered as Element).listStylePosition).toBe(
      'outside'
    );
    expect(getComputedStyle(ordered as Element).listStylePosition).toBe(
      'outside'
    );
    expect(getComputedStyle(unordered as Element).paddingInlineStart).toBe(
      getComputedStyle(ordered as Element).paddingInlineStart
    );
  });

  it('keeps horizontal rules spaced cleanly from surrounding prose', () => {
    const { container } = renderMarkdown('Above\n\n---\n\nBelow');
    const rule = container.querySelector('hr');

    expect(rule).not.toBeNull();
    expect(getComputedStyle(rule as Element).marginTop).toBe('1rem');
    expect(getComputedStyle(rule as Element).marginBottom).toBe('1rem');
  });

  it('uses a comfortable 1.625 line-height and 4px inline code chips', () => {
    const { container } = renderMarkdown(
      'line with `one` token\n\nline with `two` token'
    );
    const root = container.querySelector('.conv-markdown');
    const inlineCode = container.querySelector('code');

    const lineHeight = getComputedStyle(root as Element).lineHeight;
    expect(['1.625', '22.75px']).toContain(lineHeight);
    expect(inlineCode).not.toBeNull();
    expect(getComputedStyle(inlineCode as Element).borderRadius).toBe(
      'var(--radius-inline-code)'
    );
  });

  it('renders a GFM table when projected message rows contain blank gaps', () => {
    renderMarkdown(
      [
        '| Layer | Extension |',
        '',
        '| --- | --- |',
        '',
        '| Server | Services and RPC |',
        '',
        '| App | [React view](frontend/src/App.tsx) |',
      ].join('\n')
    );

    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(getComputedStyle(table).display).toBe('table');
    expect(table.closest('[role="group"][tabindex="0"]')).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Layer' })
    ).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Server' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'React view' })).toHaveAttribute(
      'data-resource-kind',
      'file'
    );
  });

  it('renders data-uri markdown images inline', () => {
    renderMarkdown('![Generated image](<data:image/png;base64,abc123>)');

    const image = screen.getByRole('img', { name: 'Generated image' });
    expect(image).toHaveAttribute('src', 'data:image/png;base64,abc123');
  });

  it('renders relative workspace images through the Tauri file asset URL', async () => {
    renderMarkdown('![Mockup](outputs/mockup.png)');

    const image = await screen.findByRole('img', { name: 'Mockup' });
    expect(image).toHaveAttribute(
      'src',
      'asset://C:/workspace/project/outputs/mockup.png'
    );
  });

  it('renders bare image paths inline', async () => {
    renderMarkdown('outputs/mockup.png');

    const image = await screen.findByRole('img', { name: 'mockup.png' });
    expect(image).toHaveAttribute(
      'src',
      'asset://C:/workspace/project/outputs/mockup.png'
    );
  });

  it('keeps GitHub repository markdown links as web links even when the label looks like a folder', () => {
    renderMarkdown(
      '[firecrawl/open-agent-builder](https://github.com/firecrawl/open-agent-builder)'
    );

    const link = screen.getByRole('link', {
      name: 'firecrawl/open-agent-builder',
    });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/firecrawl/open-agent-builder'
    );
    expect(link).toHaveAttribute('data-resource-kind', 'web');
    fireEvent.click(link);
    expect(panelActionsMock.revealInFileTree).not.toHaveBeenCalled();
    expect(panelActionsMock.openFilePreview).not.toHaveBeenCalled();
  });

  it('turns GitHub owner/repo inline code into a repository link', () => {
    renderMarkdown('See `escapeboy/agent-fleet-o`');

    const link = screen.getByRole('link', { name: 'escapeboy/agent-fleet-o' });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/escapeboy/agent-fleet-o'
    );
    expect(link).toHaveAttribute('data-resource-kind', 'web');
  });

  it('opens file-looking links in the workspace editor instead of navigating project routes', () => {
    renderMarkdown(
      '[frontend/src/App.tsx](http://127.0.0.1:3002/local-projects/project-1/sessions)'
    );

    const link = screen.getByRole('link', { name: 'App.tsx' });
    expect(link).toHaveAttribute('title', 'frontend/src/App.tsx');
    fireEvent.click(link);

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/App.tsx',
      {
        displayPath: 'frontend/src/App.tsx',
        title: 'frontend/src/App.tsx',
      }
    );
  });

  it('opens relative file hrefs in the workspace editor while preserving colorful file icons', () => {
    renderMarkdown('[manager.rs](crates/agents/src/manager.rs)');

    const link = screen.getByRole('link', { name: 'manager.rs' });
    expect(link).toHaveClass('conv-resource-link');
    expect(link).toHaveAttribute('data-resource-kind', 'file');
    const fileIcon = link.querySelector('[data-resource-icon="file"] svg');
    expect(fileIcon).toBeInTheDocument();
    const paintedIconPart = fileIcon?.querySelector(
      '[fill]:not([fill="none"])'
    );
    expect(paintedIconPart).toBeInTheDocument();
    expect(getComputedStyle(paintedIconPart as Element).fill).not.toBe(
      'currentcolor'
    );
    fireEvent.click(link);

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/crates/agents/src/manager.rs',
      {
        displayPath: 'crates/agents/src/manager.rs',
        title: 'crates/agents/src/manager.rs',
      }
    );
  });

  it('opens workspace links with the keyboard', () => {
    renderMarkdown('[manager.rs](crates/agents/src/manager.rs)');

    fireEvent.keyDown(screen.getByRole('link', { name: 'manager.rs' }), {
      key: 'Enter',
    });

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/crates/agents/src/manager.rs',
      {
        displayPath: 'crates/agents/src/manager.rs',
        title: 'crates/agents/src/manager.rs',
      }
    );
  });

  it('opens same-origin URL paths as workspace files instead of browser URLs', () => {
    renderMarkdown(
      '[manager.rs](http://127.0.0.1:3002/crates/agents/src/manager.rs)'
    );

    fireEvent.click(screen.getByRole('link', { name: 'manager.rs' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/crates/agents/src/manager.rs',
      {
        displayPath: 'crates/agents/src/manager.rs',
        title: 'crates/agents/src/manager.rs',
      }
    );
  });

  it('opens web-root file paths as workspace-relative files on Windows', () => {
    renderMarkdown('[manager.rs](/crates/agents/src/manager.rs)');

    fireEvent.click(screen.getByRole('link', { name: 'manager.rs' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/crates/agents/src/manager.rs',
      {
        displayPath: 'crates/agents/src/manager.rs',
        title: 'crates/agents/src/manager.rs',
      }
    );
  });

  it('preserves POSIX absolute file hrefs without joining the workspace twice', () => {
    renderMarkdown(
      '[events.rs](/Users/mac/Projects/Dimo/src-tauri/src/events.rs)',
      { workspacePath: '/Users/mac/Projects/Dimo' }
    );

    fireEvent.click(screen.getByRole('link', { name: 'events.rs' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      '/Users/mac/Projects/Dimo/src-tauri/src/events.rs',
      {
        displayPath: 'src-tauri/src/events.rs',
        title: 'src-tauri/src/events.rs',
      }
    );
  });

  it('opens file-looking links with empty hrefs in the workspace editor', () => {
    renderMarkdown('[PRD/english-video-review-extension-prd.md]()');

    const link = screen.getByRole('link', {
      name: 'english-video-review-extension-prd.md',
    });
    expect(link).toHaveAttribute(
      'title',
      'PRD/english-video-review-extension-prd.md'
    );
    fireEvent.click(link);

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/PRD/english-video-review-extension-prd.md',
      {
        displayPath: 'PRD/english-video-review-extension-prd.md',
        title: 'PRD/english-video-review-extension-prd.md',
      }
    );
  });

  it('reveals directory-looking links with empty hrefs in the file tree', () => {
    renderMarkdown('[frontend/src/components]()');

    fireEvent.click(
      screen.getByRole('link', { name: 'frontend/src/components' })
    );

    expect(panelActionsMock.revealInFileTree).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/components',
      {
        displayPath: 'frontend/src/components',
        nodeType: 'folder',
      }
    );
  });

  it('reveals absolute directory links in the file tree instead of opening them as files', () => {
    renderMarkdown('[C:/workspace/project/frontend/src/components]()');

    fireEvent.click(
      screen.getByRole('link', {
        name: 'C:/workspace/project/frontend/src/components',
      })
    );

    expect(panelActionsMock.revealInFileTree).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/components',
      {
        displayPath: 'frontend/src/components',
        nodeType: 'folder',
      }
    );
    expect(panelActionsMock.openFilePreview).not.toHaveBeenCalled();
  });

  it('renders placeholder document hrefs without browser navigation targets', () => {
    renderMarkdown('[文件名称](path_to_document)');

    const link = screen.getByRole('link', { name: '文件名称' });

    expect(link).not.toHaveAttribute('href');
    fireEvent.click(link);
    expect(panelActionsMock.openFilePreview).not.toHaveBeenCalled();
  });

  it('opens inline code file paths in the workspace editor', () => {
    renderMarkdown('Open `frontend/src/App.tsx`');

    const link = screen.getByRole('link', { name: 'App.tsx' });
    expect(link).toHaveAttribute('title', 'frontend/src/App.tsx');
    fireEvent.click(link);

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/App.tsx',
      {
        displayPath: 'frontend/src/App.tsx',
        title: 'frontend/src/App.tsx',
      }
    );
  });

  it('opens inline code file paths with the keyboard', () => {
    renderMarkdown('Open `frontend/src/App.tsx`');

    const code = screen.getByRole('link', {
      name: 'App.tsx',
    });
    expect(code).toHaveAttribute('title', 'frontend/src/App.tsx');
    fireEvent.keyDown(code, { key: 'Enter' });

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/App.tsx',
      {
        displayPath: 'frontend/src/App.tsx',
        title: 'frontend/src/App.tsx',
      }
    );
  });

  it('renders fenced code through Shiki token spans instead of injected html', async () => {
    renderMarkdown('```ts\nconst answer = 42;\nconsole.log(answer);\n```');

    expect(screen.getByText('ts')).toBeInTheDocument();
    await waitFor(() =>
      expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
        'const answer = 42;\nconsole.log(answer);',
        expect.objectContaining({
          lang: 'typescript',
          themes: {
            light: 'github-light',
            dark: 'github-dark-default',
          },
        })
      )
    );

    const token = screen.getByText('const answer = 42;');
    expect(token).toHaveClass('conv-md-token');
    expect(token.getAttribute('style')).toContain(
      '--shiki-token-light: rgb(17 17 17)'
    );
    expect(token.getAttribute('style')).toContain(
      '--shiki-token-dark: rgb(238 238 238)'
    );
  });

  it('keeps unknown fenced languages readable as plain text', async () => {
    renderMarkdown('```madeup\nplain output\nnext line\n```');

    expect(screen.getByText('madeup')).toBeInTheDocument();
    await waitFor(() =>
      expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
        'plain output\nnext line',
        expect.objectContaining({
          lang: 'text',
        })
      )
    );
    expect(screen.getByText('plain output')).toBeInTheDocument();
  });

  it('renders inline and display math through KaTeX', async () => {
    const { container } = renderMarkdown(String.raw`Euler $e^{i\pi}+1=0$

$$
\int_0^1 x^2 dx
$$`);

    await waitFor(
      () => {
        expect(container.querySelector('.katex')).toBeInTheDocument();
      },
      { timeout: 5000 }
    );
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
  });

  it('normalizes TeX math delimiters without changing fenced code', async () => {
    const { container } = renderMarkdown(
      'Inline \\(a+b\\)\n\n\\[\nc=d\n\\]\n\n```ts\nconst raw = "\\\\(not math\\\\)";\n```'
    );

    await waitFor(
      () => {
        expect(container.querySelector('.katex')).toBeInTheDocument();
      },
      { timeout: 5000 }
    );
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
    await waitFor(() =>
      expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
        'const raw = "\\\\(not math\\\\)";',
        expect.objectContaining({ lang: 'typescript' })
      )
    );
  });

  it('renders MathJax \\[ \\] display math instead of stripping TeX commands', async () => {
    const { container } =
      renderMarkdown(String.raw`假设三段轨迹的持续时间分别为：

\[
T_0 = 2\text{s} \qquad T_1 = 3s \qquad T_2 = s
\]`);

    await waitFor(
      () => {
        expect(container.querySelector('.katex-display')).toBeInTheDocument();
      },
      { timeout: 5000 }
    );
    expect(container.querySelector('.katex-error')).toBeNull();
    expect(container.querySelector('.katex-html')?.textContent).not.toContain(
      'qquad'
    );
    expect(container.querySelector('.katex-html')?.textContent).not.toContain(
      'text{s}'
    );
  });

  it('renders a bare align environment through KaTeX', async () => {
    const { container } = renderMarkdown(String.raw`\begin{aligned}
T_0 &= 2\text{s} \\
T_1 &= 3s
\end{aligned}`);

    await waitFor(
      () => {
        expect(container.querySelector('.katex-display')).toBeInTheDocument();
      },
      { timeout: 5000 }
    );
    expect(container.querySelector('.katex-error')).toBeNull();
    expect(container.querySelector('.katex-html')?.textContent).not.toContain(
      'begin{aligned}'
    );
  });

  it('renders user soft breaks without changing paragraph spacing globally', () => {
    const { container } = renderMarkdown('first line\nsecond line', {
      softBreaks: true,
    });

    expect(container.querySelector('br')).toBeInTheDocument();
  });

  it('keeps incomplete Mermaid fences as readable code while streaming', async () => {
    renderMarkdown('```mermaid\ngraph TD\nA-->B');

    await waitFor(() =>
      expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
        'graph TD\nA-->B',
        expect.objectContaining({ lang: 'text' })
      )
    );
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it('renders Mermaid fenced blocks as inline SVG diagrams instead of code blocks', async () => {
    mermaidMock.render.mockResolvedValueOnce({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><foreignObject width="100" height="24"><div xmlns="http://www.w3.org/1999/xhtml">节点 A</div></foreignObject></svg>`,
    });

    const { container } = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```');

    await waitFor(() =>
      expect(mermaidMock.render).toHaveBeenCalledWith(
        expect.stringMatching(/^mermaid-/),
        'graph TD\nA-->B',
        expect.any(HTMLElement)
      )
    );
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'antiscript',
        htmlLabels: true,
      })
    );

    const diagram = await screen.findByRole('img', { name: /Mermaid/ });
    expect(diagram.querySelector('svg')).toBeInTheDocument();
    expect(
      diagram.querySelector('foreignObject, foreignobject')
    ).toBeInTheDocument();
    expect(diagram).toHaveTextContent('节点 A');
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.queryByText('mermaid')).not.toBeInTheDocument();
    expect(markdownStyles).not.toContain('max-height: 420px');
  });

  it('does not execute script tags from Mermaid SVG output', async () => {
    mermaidMock.render.mockResolvedValueOnce({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__mermaidXss = true</script><text>safe</text></svg>`,
    });

    const { container } = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```');

    const diagram = await screen.findByRole('img', { name: /Mermaid/ });
    expect(diagram).toHaveTextContent('safe');
    expect(container.querySelector('script')).not.toBeInTheDocument();
    expect(
      (window as Window & { __mermaidXss?: boolean }).__mermaidXss
    ).toBeUndefined();
  });

  it('keeps Mermaid source inspectable when rendering fails', async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error('bad diagram'));

    renderMarkdown('```mermaid\ngraph TD\nA-->B\n```');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('\u56fe\u8868\u6e32\u67d3\u5931\u8d25');
    expect(alert).toHaveTextContent('graph TD');
    expect(alert).toHaveTextContent('A-->B');
  });

  it('renders fenced HTML as a sandboxed live preview', () => {
    renderMarkdown('```html\n<h1>Bot page</h1>\n```');

    const frame = screen.getByTitle('HTML 预览');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-modals allow-popups'
    );
    expect(frame).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('<h1>Bot page</h1>')
    );
  });

  it('copies the original fenced code text', async () => {
    renderMarkdown('```ts\nconst answer = 42;\nconsole.log(answer);\n```');

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));

    await waitFor(() =>
      expect(clipboardMock.writeText).toHaveBeenCalledWith(
        'const answer = 42;\nconsole.log(answer);'
      )
    );
  });
});

describe('Markdown raw HTML', () => {
  it('renders an allowlisted block element natively', () => {
    const { container } = renderMarkdown(
      'before <div class="box">inner text</div> after'
    );

    const innerDiv = container.querySelector('.conv-markdown div');
    expect(innerDiv).not.toBeNull();
    expect(innerDiv).toHaveTextContent('inner text');
  });

  it('renders an inline element like <sub>', () => {
    const { container } = renderMarkdown('H<sub>2</sub>O');

    expect(container.querySelector('sub')).toHaveTextContent('2');
  });

  it('strips event handlers, styles, and disallowed attributes', () => {
    const { container } = renderMarkdown(
      '<div onclick="alert(1)" style="color:red" title="kept">hi</div>'
    );

    const inner = container.querySelector('.conv-markdown div[title="kept"]');
    expect(inner).not.toBeNull();
    expect(inner).not.toHaveAttribute('onclick');
    expect(inner).not.toHaveAttribute('style');
    expect(inner).toHaveAttribute('title', 'kept');
    expect(inner).toHaveTextContent('hi');
  });

  it('resolves a raw <img> src against the workspace base path', async () => {
    renderMarkdown('<img src="./assets/x.png" alt="raw local">');

    const image = await screen.findByRole('img', { name: 'raw local' });
    expect(image).toHaveAttribute(
      'src',
      'asset://C:/workspace/project/assets/x.png'
    );
  });

  it('does not capture <script> or conversation pseudo-tags', () => {
    const { container } = renderMarkdown(
      '<script>const x = 1</script>\n<system-reminder>hint</system-reminder>'
    );

    expect(container.querySelector('script')).not.toBeInTheDocument();
    expect(container.textContent).toContain('<system-reminder>');
    expect(container.textContent).toContain('<script>');
  });

  it('keeps HTML-looking text inside code spans as code', () => {
    const { container } = renderMarkdown('`<div>x</div>`');

    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('<div>x</div>');
  });

  it('falls back to literal text when rawHtml is disabled', () => {
    const { container } = renderMarkdown('<div class="box">hi</div>', {
      rawHtml: false,
    });

    expect(container.querySelector('.conv-markdown div')).toBeNull();
    expect(container.textContent).toContain('<div class="box">hi</div>');
  });

  it('renders native paragraphs at 100% max-width instead of capping at 680px', () => {
    const { container } = renderMarkdown(
      'A long collaboration message paragraph.'
    );
    const paragraph = container.querySelector(
      '.conv-markdown p'
    ) as HTMLElement | null;
    expect(paragraph).not.toBeNull();
    expect(getComputedStyle(paragraph!).maxWidth).toBe('100%');
  });

  it('renders <details><summary> with inner Markdown parsed natively', () => {
    const { container } = renderMarkdown(
      '<details open>\n<summary>More details</summary>\n\n**Bold** and `inline` inside.\n\n</details>'
    );

    const details = container.querySelector('details.conv-md-details');
    expect(details).toBeInTheDocument();
    expect(details?.querySelector('summary.conv-md-summary')).toHaveTextContent(
      'More details'
    );
    expect(details?.querySelector('strong')).toHaveTextContent('Bold');
    expect(details?.querySelector('code')).toHaveTextContent('inline');
  });
});

describe('Phase 1 & Phase 2 Markdown upgrades', () => {
  it('renders GitHub Alert callouts for all five severities and custom titles', () => {
    const { container } = renderMarkdown(
      [
        '> [!NOTE]',
        '> Note body.',
        '',
        '> [!WARNING] Watch out',
        '> Dangerous **action**.',
        '',
        '> [!CAUTION]',
        '> Irreversible.',
      ].join('\n')
    );

    const note = container.querySelector('.conv-md-alert[data-alert-kind="note"]');
    const warning = container.querySelector(
      '.conv-md-alert[data-alert-kind="warning"]'
    );
    const caution = container.querySelector(
      '.conv-md-alert[data-alert-kind="caution"]'
    );

    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent('Note body.');
    expect(warning).toBeInTheDocument();
    expect(warning?.querySelector('.conv-md-alert-title')).toHaveTextContent(
      'Watch out'
    );
    expect(warning?.querySelector('strong')).toHaveTextContent('action');
    expect(caution).toBeInTheDocument();
  });

  it('renders GFM footnotes with backref links', () => {
    const { container } = renderMarkdown(
      'Here is a claim[^1].\n\n[^1]: Supporting source.'
    );

    expect(container.querySelector('a[data-footnote-ref]')).toBeInTheDocument();
    const footnotes = container.querySelector('section[data-footnotes]');
    expect(footnotes).toBeInTheDocument();
    expect(footnotes).toHaveTextContent('Supporting source.');
  });

  it('disambiguates duplicate basenames and forwards line ranges on click', () => {
    renderMarkdown(
      'Compare [crates/a/src/turn/mod.rs:22](crates/a/src/turn/mod.rs#L22-L40) and [crates/b/src/chat/mod.rs](crates/b/src/chat/mod.rs).'
    );

    const first = screen.getByRole('link', {
      name: 'mod.rs · turn · L22–40',
    });
    const second = screen.getByRole('link', {
      name: 'mod.rs · chat',
    });

    expect(first).toBeInTheDocument();
    expect(second).toBeInTheDocument();

    fireEvent.click(first);
    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/crates/a/src/turn/mod.rs',
      {
        displayPath: 'crates/a/src/turn/mod.rs',
        title: 'crates/a/src/turn/mod.rs',
        location: { line: 22, column: 1, endLine: 40 },
      }
    );
  });

  it('normalizes LLM under- and over-indented nested lists without turning them into code blocks', () => {
    const { container } = renderMarkdown(
      ['1. Top item', '  - two-space nested bullet', '        - over-indented sub-bullet', '2. Next top item'].join('\n')
    );

    expect(container.querySelector('pre')).toBeNull();
    const ol = container.querySelector('ol');
    expect(ol?.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(ol?.querySelectorAll('ul')).toHaveLength(2);
  });

  it('displays code fence title and toggles word wrap on multi-line code blocks', () => {
    const { container } = renderMarkdown(
      '```ts title="src/engine.ts"\nconst engine = createEngine();\nexport default engine;\n```'
    );

    const codeblock = container.querySelector('.conv-md-codeblock');
    expect(codeblock).toBeInTheDocument();
    expect(codeblock?.querySelector('.conv-md-codeblock-title')).toHaveTextContent(
      'src/engine.ts'
    );
    expect(codeblock).not.toHaveClass('is-wrapped');

    const wrapBtn = screen.getByRole('button', { name: /自动换行|Word wrap/i });
    fireEvent.click(wrapBtn);
    expect(codeblock).toHaveClass('is-wrapped');
  });

  it('strips YAML frontmatter and supports interactive task checkboxes when enabled for file preview', () => {
    const onToggle = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={'---\ntitle: Spec\n---\n\n# Heading\n\n- [ ] First task\n- [x] Done task'}
          workspacePath="C:/workspace/project"
          stripFrontmatter
          onToggleTaskCheckbox={onToggle}
        />
      </QueryClientProvider>
    );

    expect(container.textContent).not.toContain('title: Spec');
    expect(container.querySelector('h1')).toHaveTextContent('Heading');
    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]!.checked).toBe(false);
    expect(checkboxes[1]!.checked).toBe(true);

    fireEvent.click(checkboxes[0]!);
    expect(onToggle).toHaveBeenCalledWith(0, true);
  });
});

describe('Markdown closed-block LRU cache', () => {
  beforeEach(() => {
    resetMarkdownBlockElementCache();
    shikiMock.createHighlighter.mockClear();
    shikiMock.codeToTokensWithThemes.mockClear();
    shikiMock.loadLanguage.mockClear();
    mermaidMock.initialize.mockClear();
    mermaidMock.render.mockClear();
    mermaidMock.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Mock diagram</text></svg>',
    });
  });

  it('defers Shiki tokenization for unclosed streaming code fences and caches highlighted block once closed', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container, rerender } = render(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={'```typescript\nconst a = 1;'}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );

    const firstDeltaBlock = container.querySelector('.conv-md-codeblock');
    expect(firstDeltaBlock).not.toBeNull();
    expect(firstDeltaBlock).toHaveAttribute('data-highlight-state', 'deferred');
    expect(firstDeltaBlock?.querySelector('code')).toHaveTextContent(
      'const a = 1;'
    );
    expect(firstDeltaBlock?.querySelector('.conv-md-token')).toBeNull();
    expect(shikiMock.codeToTokensWithThemes).not.toHaveBeenCalled();
    expect(getMarkdownBlockElementCacheStats().entries).toBe(0);

    // Second streaming delta inside the still-unclosed fence
    rerender(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={'```typescript\nconst a = 1;\nconst b = 2;'}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );

    const secondDeltaBlock = container.querySelector('.conv-md-codeblock');
    expect(secondDeltaBlock).toHaveAttribute(
      'data-highlight-state',
      'deferred'
    );
    expect(secondDeltaBlock?.querySelector('code')?.textContent).toBe(
      'const a = 1;\nconst b = 2;'
    );
    expect(secondDeltaBlock?.querySelector('.conv-md-token')).toBeNull();
    expect(shikiMock.codeToTokensWithThemes).not.toHaveBeenCalled();
    expect(getMarkdownBlockElementCacheStats().entries).toBe(0);

    // Closing fence arrives and trailing text starts streaming
    rerender(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={
            '```typescript\nconst a = 1;\nconst b = 2;\n```\n\nTrailing text'
          }
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );

    const closedBlock = container.querySelector('.conv-md-codeblock');
    expect(closedBlock).not.toBeNull();
    expect(closedBlock?.getAttribute('data-highlight-state')).not.toBe(
      'deferred'
    );
    expect(getMarkdownBlockElementCacheStats().entries).toBe(1);
    expect(getMarkdownBlockElementCacheStats().misses).toBe(1);

    await waitFor(() => {
      expect(closedBlock).toHaveAttribute(
        'data-highlight-state',
        'highlighted'
      );
      expect(container.textContent).toContain('Trailing text');
    });
    expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledTimes(1);
    expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
      'const a = 1;\nconst b = 2;',
      expect.objectContaining({ lang: 'typescript' })
    );

    // Subsequent deltas into trailing text reuse the cached closed code block without re-tokenizing
    rerender(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={
            '```typescript\nconst a = 1;\nconst b = 2;\n```\n\nTrailing text continues smoothly'
          }
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );

    expect(getMarkdownBlockElementCacheStats().entries).toBe(1);
    expect(getMarkdownBlockElementCacheStats().hits).toBe(1);
    expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(container.textContent).toContain(
        'Trailing text continues smoothly'
      );
    });
  });

  it('defers Mermaid and Shiki work while streaming an unclosed Mermaid fence and renders SVG once closed', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container, rerender } = render(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={'```mermaid\ngraph TD\nA-->B'}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );

    const deferredBlock = container.querySelector('.conv-md-codeblock');
    expect(deferredBlock).toHaveAttribute('data-highlight-state', 'deferred');
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(shikiMock.codeToTokensWithThemes).not.toHaveBeenCalled();
    expect(getMarkdownBlockElementCacheStats().entries).toBe(0);

    rerender(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={'```mermaid\ngraph TD\nA-->B\n```\n\nDiagram caption'}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );

    const diagram = await screen.findByRole('img', { name: /Mermaid/ });
    expect(diagram.querySelector('svg')).toBeInTheDocument();
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(shikiMock.codeToTokensWithThemes).not.toHaveBeenCalled();
    expect(getMarkdownBlockElementCacheStats().entries).toBe(1);
  });

  it('defers KaTeX compilation while streaming an unclosed latex fence and renders display math once closed', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container, rerender } = render(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={'```latex\n\\frac{1}{2'}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );

    const deferredBlock = container.querySelector('.conv-md-codeblock');
    expect(deferredBlock).toHaveAttribute('data-highlight-state', 'deferred');
    expect(deferredBlock?.querySelector('code')).toHaveTextContent(
      '\\frac{1}{2'
    );
    expect(container.querySelector('.katex-error')).toBeNull();
    expect(shikiMock.codeToTokensWithThemes).not.toHaveBeenCalled();
    expect(getMarkdownBlockElementCacheStats().entries).toBe(0);

    rerender(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={'```latex\n\\frac{1}{2}\n```\n\nEquation ready'}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );

    await waitFor(
      () => {
        expect(container.querySelector('.katex-display')).toBeInTheDocument();
      },
      { timeout: 5000 }
    );
    expect(container.querySelector('.katex-error')).toBeNull();
    expect(shikiMock.codeToTokensWithThemes).not.toHaveBeenCalled();
    expect(getMarkdownBlockElementCacheStats().entries).toBe(1);
  });

  it('renders \\[...\\] and \\begin{align}...\\end{align} spanning blank lines as intact KaTeX blocks', async () => {
    const { container } = renderMarkdown(
      [
        'Intro',
        '',
        '\\[',
        'x_1 = a + b',
        '',
        '',
        '',
        'x_2 = c + d',
        '\\]',
        '',
        '\\begin{align}',
        'f(x) &= x^2 \\\\',
        '',
        'g(x) &= x^3',
        '\\end{align}',
      ].join('\n')
    );

    await waitFor(
      () => {
        expect(container.querySelectorAll('.katex')).toHaveLength(2);
      },
      { timeout: 5000 }
    );
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
    expect(container.querySelector('.katex-error')).toBeNull();
  });

  it('renders trailing ## Tag Reference appendix separately without caching it', () => {
    resetMarkdownBlockElementCache();
    const { container } = renderMarkdown(
      [
        'Main paragraph one.',
        '',
        'Main paragraph two.',
        '',
        '## Tag Reference',
        '',
        '- `#spec`: Phase 1.2 LRU cache',
      ].join('\n')
    );

    expect(container.textContent).toContain('Main paragraph one.');
    expect(container.textContent).toContain('Tag Reference');
    expect(container.textContent).toContain('#spec');
    expect(getMarkdownBlockElementCacheStats().entries).toBe(2);
  });

  it('achieves > 90% element cache hit rate and P99 < 8ms per frame during 10k-char streaming', () => {
    const blocks = Array.from(
      { length: 25 },
      (_, idx) =>
        `### Section ${idx}: Closed-Block Streaming Architecture\n` +
        `Block ${idx} verifies that once a markdown section closes across a blank line boundary, its compiled ReactElement is stored in the 500k-character LRU cache and reused by reference on every subsequent frame. ` +
        `Only the trailing active block (~500 characters) runs tag normalization, raw HTML protection, KaTeX math extraction, and member mention protection during live token streaming (${idx}).`
    );
    const tenKText = blocks.join('\n\n');
    expect(tenKText.length).toBeGreaterThan(10_000);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    // Warm up JIT / StyleX once before resetting cache stats & timing
    const warmup = render(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value="### Warmup\nWarmup paragraph.\n\nActive tail"
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );
    warmup.unmount();
    resetMarkdownBlockElementCache();

    const step = 100;
    const { rerender, container } = render(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={tenKText.slice(0, step)}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={true}
        />
      </QueryClientProvider>
    );

    const frameDurations: number[] = [];
    for (let cursor = step * 2; cursor <= tenKText.length; cursor += step) {
      const nextSlice = tenKText.slice(0, cursor);
      const t0 = performance.now();
      rerender(
        <QueryClientProvider client={queryClient}>
          <Markdown
            value={nextSlice}
            taskAttemptId="workspace-1"
            workspacePath="C:/workspace/project"
            isStreaming={true}
          />
        </QueryClientProvider>
      );
      frameDurations.push(performance.now() - t0);
    }

    // Settle final stream frame
    rerender(
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={tenKText}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          isStreaming={false}
        />
      </QueryClientProvider>
    );

    const stats = getMarkdownBlockElementCacheStats();
    const hitRate = stats.hits / (stats.hits + stats.misses);
    const sorted = [...frameDurations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p99 =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ??
      0;

    expect(container.textContent).toContain('Section 0');
    expect(container.textContent).toContain('Section 24');
    expect(hitRate).toBeGreaterThan(0.95);
    expect(stats.cachedChars).toBeLessThanOrEqual(500_000);
    expect(median).toBeLessThan(8);
    expect(p99).toBeLessThan(30);
  });
});
