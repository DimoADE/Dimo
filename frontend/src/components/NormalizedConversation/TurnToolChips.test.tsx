import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { TurnActivity } from './TurnActivity';
import type { IndexedTurnItem } from './messageTurnAggregate';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';

const INITIAL_LANGUAGE = i18n.language;

const { openFilePreviewMock } = vi.hoisted(() => ({
  openFilePreviewMock: vi.fn(),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => ({
    openFilePreview: openFilePreviewMock,
    revealInFileTree: vi.fn(),
  }),
}));

vi.mock('./DisplayConversationEntry', () => ({
  default: ({ entry }: { entry: { content: string } }) => (
    <div data-testid="tool-detail-entry">{entry.content}</div>
  ),
}));

function makeToolItem(
  index: number,
  toolName: string,
  input: unknown,
  output: string | null = 'ok',
  isError = false
): IndexedTurnItem {
  const use: ToolUseBlock = {
    type: 'tool_use',
    tool_use_id: `tool-${index}`,
    tool_name: toolName,
    kind: null,
    input_preview: JSON.stringify(input),
    meta: null,
  };
  const result: ToolResultBlock | null =
    output == null
      ? null
      : {
          type: 'tool_result',
          tool_use_id: `tool-${index}`,
          output_preview: output,
          is_error: isError,
          agent_stats: null,
        };
  return {
    item: { kind: 'tool', use, result },
    index,
  };
}

describe('TurnToolChips integration in TurnActivity', () => {
  beforeEach(() => {
    openFilePreviewMock.mockReset();
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage(INITIAL_LANGUAGE);
  });

  it('keeps aggregated file-diff chips visible while collapsed, previews unified diff in a portal on hover, and opens inline diff on click', () => {
    render(
      <TurnActivity
        turnId="turn-diff-chips"
        timestamp="2026-10-12T00:00:00.000Z"
        workspacePath="/workspace/app"
        items={[
          makeToolItem(0, 'Edit', {
            file_path: '/workspace/app/src/api/route.ts',
            old_string: 'const limit = 10;',
            new_string: 'const limit = 25;\nconst burst = 5;',
          }),
          makeToolItem(1, 'Edit', {
            file_path: '/workspace/app/src/api/route.ts',
            old_string: 'return ok();',
            new_string: 'return ok({ limit });',
          }),
          makeToolItem(2, 'bash', { command: 'pnpm test' }, 'PASS'),
        ]}
        attempt={{ id: 'ws-1', container_ref: '/workspace/app' } as never}
        task={null}
      />
    );

    const header = screen.getByRole('button', {
      name: '运行 1 个命令、已改 2 个文件',
    });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('turn-tool-chip-row')).not.toBeInTheDocument();

    const diffBar = screen.getByTestId('turn-tool-diff-chips');
    const chip = within(diffBar).getByRole('button', {
      name: '查看 src/api/route.ts 的变更',
    });
    expect(chip).toHaveTextContent('route.ts');
    expect(chip).toHaveTextContent('+3');
    expect(chip).toHaveTextContent('-2');

    fireEvent.mouseEnter(chip);
    const preview = screen.getByTestId('turn-tool-diff-preview');
    expect(preview).toHaveTextContent('src/api/route.ts');
    expect(preview).toHaveTextContent('const limit = 25;');
    expect(preview).toHaveTextContent('const limit = 10;');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      screen.queryByTestId('turn-tool-diff-preview')
    ).not.toBeInTheDocument();

    fireEvent.click(chip);
    expect(openFilePreviewMock).toHaveBeenCalledWith(
      '/workspace/app/src/api/route.ts',
      {
        mode: 'diff',
        diffViewMode: 'inline',
        displayPath: 'src/api/route.ts',
        title: 'src/api/route.ts',
      }
    );
  });

  it('disambiguates duplicate basenames and folds >5 diff chips behind a +N more button', () => {
    const items = [
      makeToolItem(0, 'Edit', {
        file_path: 'src/auth/index.ts',
        old_string: 'a',
        new_string: 'b',
      }),
      makeToolItem(1, 'Edit', {
        file_path: 'src/billing/index.ts',
        old_string: 'a',
        new_string: 'b',
      }),
      ...Array.from({ length: 5 }, (_, idx) =>
        makeToolItem(idx + 2, 'Edit', {
          file_path: `src/mod-${idx}.ts`,
          old_string: 'old',
          new_string: 'new',
        })
      ),
    ];

    render(
      <TurnActivity
        turnId="turn-many-diffs"
        timestamp="2026-10-12T00:00:00.000Z"
        workspacePath="/workspace/app"
        items={items}
        attempt={{ id: 'ws-1', container_ref: '/workspace/app' } as never}
        task={null}
      />
    );

    const diffBar = screen.getByTestId('turn-tool-diff-chips');
    expect(within(diffBar).getByText('auth/index.ts')).toBeInTheDocument();
    expect(within(diffBar).getByText('billing/index.ts')).toBeInTheDocument();
    expect(within(diffBar).queryByText('mod-4.ts')).not.toBeInTheDocument();

    const moreButton = within(diffBar).getByRole('button', { name: '+2 更多' });
    fireEvent.click(moreButton);
    expect(within(diffBar).getByText('mod-4.ts')).toBeInTheDocument();
    expect(
      within(diffBar).queryByRole('button', { name: /\+\d+ 更多/ })
    ).not.toBeInTheDocument();
  });

  it('expands a tool row via keyboard and keeps its accessible name clean while rendering left-guide detail', () => {
    render(
      <TurnActivity
        turnId="turn-row-keyboard"
        timestamp="2026-10-12T00:00:00.000Z"
        items={[
          makeToolItem(0, 'bash', { command: 'pnpm lint' }, '0 warnings'),
        ]}
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        isStreaming={true}
      />
    );

    const row = screen.getByRole('button', { name: 'pnpm lint' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('tool-detail-entry')).not.toBeInTheDocument();

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'pnpm lint' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByTestId('tool-detail-entry')).toBeInTheDocument();
  });

  it('folds failed tools inside the collapsed batch while keeping the bottom file diff summary visible', () => {
    render(
      <TurnActivity
        turnId="turn-collapsed-errors"
        timestamp="2026-10-12T00:00:00.000Z"
        workspacePath="/workspace/app"
        items={[
          makeToolItem(0, 'Edit', {
            file_path: '/workspace/app/src/ok.ts',
            old_string: 'const a = 1;',
            new_string: 'const a = 2;',
          }),
          makeToolItem(
            1,
            'bash',
            { command: 'git status --short' },
            JSON.stringify({ exit_code: 1, stderr: 'bad flag' }),
            true
          ),
          makeToolItem(
            2,
            'Edit',
            {
              file_path: '/workspace/app/shared/types.ts',
              old_string: 'missing',
              new_string: 'updated',
            },
            'TargetContent not found',
            true
          ),
        ]}
        attempt={{ id: 'ws-1', container_ref: '/workspace/app' } as never}
        task={null}
      />
    );

    const header = screen.getByRole('button', {
      name: '运行 1 个命令、已改 2 个文件',
    });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('turn-tool-chip-row')).not.toBeInTheDocument();
    expect(screen.queryByText(/git status --short/)).not.toBeInTheDocument();
    expect(screen.queryByText('工具调用失败')).not.toBeInTheDocument();

    const diffBar = screen.getByTestId('turn-tool-diff-chips');
    expect(within(diffBar).getByText('ok.ts')).toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const rows = screen.getAllByTestId('turn-tool-chip-row');
    expect(rows).toHaveLength(3);
    expect(screen.getByText(/git status --short/)).toBeInTheDocument();
    expect(rows[1]).toHaveClass('is-error');
    expect(rows[1]).toHaveAttribute('title', '命令退出码 1');
    expect(rows[2]).toHaveClass('is-error');
    expect(rows[2]).toHaveAttribute('title', '工具调用失败');
    expect(document.querySelector('.conv-tool-chip-error-badge')).toBeNull();
  });

  it('renders synthesized unified_diff counts and honors precomputed stats when diff_truncated is true', () => {
    const antigravityEdit: IndexedTurnItem = {
      index: 0,
      item: {
        kind: 'tool',
        use: {
          type: 'tool_use',
          tool_use_id: 'agy-1',
          tool_name: '0e17fa2c-d6bb-4fae-af74-b91e1221654e:258',
          kind: 'edit',
          input_preview: JSON.stringify({
            file_path: '/workspace/app/src/messageTurnTool.ts',
            unified_diff: [
              '--- a/src/messageTurnTool.ts',
              '+++ b/src/messageTurnTool.ts',
              '@@ -10,2 +10,3 @@',
              '-const oldLine = 1;',
              '+const newLine = 2;',
              '+const extraLine = 3;',
            ].join('\n'),
          }),
          meta: null,
        },
        result: {
          type: 'tool_result',
          tool_use_id: 'agy-1',
          output_preview: 'Edited file',
          is_error: false,
          agent_stats: null,
        },
      },
    };

    const largeTruncatedEdit: IndexedTurnItem = {
      index: 1,
      item: {
        kind: 'tool',
        use: {
          type: 'tool_use',
          tool_use_id: 'agy-2',
          tool_name: 'Running edit_file',
          kind: 'edit',
          input_preview: JSON.stringify({
            file_path: '/workspace/app/src/largeFile.ts',
            unified_diff: [
              '--- a/src/largeFile.ts',
              '+++ b/src/largeFile.ts',
              '@@ -1,1 +1,420 @@',
              '-const legacy = true;',
              '+const rewritten = true;',
            ].join('\n'),
            additions: 420,
            deletions: 17,
            diff_truncated: true,
          }),
          meta: null,
        },
        result: {
          type: 'tool_result',
          tool_use_id: 'agy-2',
          output_preview: 'Edited large file',
          is_error: false,
          agent_stats: null,
        },
      },
    };

    render(
      <TurnActivity
        turnId="turn-synthesized-diffs"
        timestamp="2026-10-12T00:00:00.000Z"
        workspacePath="/workspace/app"
        items={[antigravityEdit, largeTruncatedEdit]}
        attempt={{ id: 'ws-1', container_ref: '/workspace/app' } as never}
        task={null}
      />
    );

    const diffBar = screen.getByTestId('turn-tool-diff-chips');
    const firstChip = within(diffBar).getByRole('button', {
      name: '查看 src/messageTurnTool.ts 的变更',
    });
    expect(firstChip).toHaveTextContent('+2');
    expect(firstChip).toHaveTextContent('-1');

    const secondChip = within(diffBar).getByRole('button', {
      name: '查看 src/largeFile.ts 的变更',
    });
    expect(secondChip).toHaveTextContent('+420');
    expect(secondChip).toHaveTextContent('-17');
  });

  it('renders a single settled tool call directly without wrapping it in a batch', () => {
    render(
      <TurnActivity
        turnId="turn-single-settled"
        timestamp="2026-10-12T00:00:00.000Z"
        workspacePath="/workspace/app"
        items={[
          makeToolItem(0, 'Edit', {
            file_path: '/workspace/app/src/solo.ts',
            old_string: 'const a = 1;',
            new_string: 'const a = 2;',
          }),
        ]}
        attempt={{ id: 'ws-1', container_ref: '/workspace/app' } as never}
        task={null}
        isStreaming={false}
      />
    );

    expect(
      screen.queryByTestId('turn-tool-chips-batch')
    ).not.toBeInTheDocument();
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(row).toHaveTextContent('solo.ts');
    expect(row).toHaveTextContent('+1');
    expect(row).toHaveTextContent('-1');
  });

  it('groups streaming tool calls into one unified live batch and preserves expansion on settlement', () => {
    const items = [
      makeToolItem(0, 'bash', { command: 'echo 0' }, '0'),
      makeToolItem(1, 'bash', { command: 'echo 1' }, '1'),
      makeToolItem(2, 'bash', { command: 'echo 2' }, null),
    ];
    const props = {
      turnId: 'turn-unified-live',
      timestamp: '2026-10-12T00:00:00.000Z',
      items,
      attempt: { id: 'ws-1', container_ref: null } as never,
      task: null,
    };
    const { rerender } = render(<TurnActivity {...props} isStreaming={true} />);

    expect(screen.getAllByTestId('turn-tool-chips-batch')).toHaveLength(1);
    expect(screen.queryByTestId('turn-tool-chip-row')).not.toBeInTheDocument();
    const liveHeader = screen.getByRole('button', { name: 'echo 2' });
    expect(liveHeader).toHaveClass('is-live');
    expect(liveHeader).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(liveHeader);
    const viewport = screen.getByTestId('turn-tool-chips-viewport');
    expect(viewport).toHaveAttribute('role', 'region');
    expect(viewport).toHaveAttribute('data-tool-group-scroll');
    expect(viewport).toHaveAttribute('data-overlay-scrollbar', 'off');
    expect(viewport).toHaveAttribute('data-scroll-fade', 'none');
    expect(within(viewport).getAllByTestId('turn-tool-chip-row')).toHaveLength(
      3
    );

    rerender(
      <TurnActivity
        {...props}
        items={[
          items[0]!,
          items[1]!,
          makeToolItem(2, 'bash', { command: 'echo 2' }, '2'),
        ]}
        isStreaming={false}
      />
    );

    const settledHeader = screen.getByRole('button', { name: '运行 3 个命令' });
    expect(settledHeader).not.toHaveClass('is-live');
    expect(settledHeader).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('turn-tool-chip-row')).toHaveLength(3);
  });

  it('formats priority-ordered Top-2 plus other actions summaries in zh-CN and en', async () => {
    const items = [
      makeToolItem(0, 'bash', { command: 'pnpm test' }, 'ok'),
      makeToolItem(1, 'bash', { command: 'pnpm lint' }, 'ok'),
      makeToolItem(2, 'Read', { file_path: 'src/a.ts' }, 'ok'),
      makeToolItem(3, 'Read', { file_path: 'src/b.ts' }, 'ok'),
      makeToolItem(4, 'Edit', {
        file_path: 'src/a.ts',
        old_string: 'a',
        new_string: 'b',
      }),
      makeToolItem(5, 'Grep', { pattern: 'foo' }, 'ok'),
    ];
    const props = {
      turnId: 'turn-top2-summary',
      timestamp: '2026-10-12T00:00:00.000Z',
      items,
      attempt: { id: 'ws-1', container_ref: null } as never,
      task: null,
      isStreaming: false,
    };

    const { rerender } = render(<TurnActivity {...props} />);
    expect(
      screen.getByRole('button', {
        name: '运行 2 个命令、已改 1 个文件，以及其他 3 项操作',
      })
    ).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('en');
    });
    rerender(<TurnActivity {...props} />);
    expect(
      screen.getByRole('button', {
        name: 'Ran 2 commands, changed 1 file, and performed 3 other actions',
      })
    ).toBeInTheDocument();
  });

  it('updates scroll fades and dynamic --conv-batch-expanded-extra height inside the batch viewport', () => {
    render(
      <TurnActivity
        turnId="turn-viewport-metrics"
        timestamp="2026-10-12T00:00:00.000Z"
        items={[
          makeToolItem(0, 'bash', { command: 'cmd-0' }, 'output-0'),
          makeToolItem(1, 'bash', { command: 'cmd-1' }, 'output-1'),
        ]}
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        isStreaming={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '运行 2 个命令' }));
    const viewport = screen.getByTestId('turn-tool-chips-viewport');
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      value: 500,
    });

    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(viewport).toHaveAttribute('data-scroll-fade', 'bottom');

    viewport.scrollTop = 120;
    fireEvent.scroll(viewport);
    expect(viewport).toHaveAttribute('data-scroll-fade', 'both');

    viewport.scrollTop = 300;
    fireEvent.scroll(viewport);
    expect(viewport).toHaveAttribute('data-scroll-fade', 'top');

    fireEvent.click(screen.getByRole('button', { name: 'cmd-0' }));
    const detail = viewport.querySelector('.conv-tool-chip-detail');
    expect(detail).not.toBeNull();
    Object.defineProperty(detail, 'offsetHeight', {
      configurable: true,
      value: 140,
    });
    fireEvent.scroll(viewport);
    expect(viewport.style.getPropertyValue('--conv-batch-expanded-extra')).toBe(
      '140px'
    );
  });

  it('keeps the left semantic icon with error tint and right-aligned chevron on failed rows', () => {
    render(
      <TurnActivity
        turnId="turn-failed-row-layout"
        timestamp="2026-10-12T00:00:00.000Z"
        items={[
          makeToolItem(0, 'Read', { file_path: 'src/ok.ts' }, 'ok'),
          makeToolItem(
            1,
            'Read',
            { file_path: 'src/missing.ts' },
            'ENOENT',
            true
          ),
        ]}
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        isStreaming={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '已读 2 个文件' }));
    const items = screen.getAllByTestId('turn-tool-chip-item');
    const failedItem = items[1]!;
    const failedRow = within(failedItem).getByTestId('turn-tool-chip-row');
    expect(failedItem).toHaveAttribute('data-tool-status', 'error');
    expect(failedRow).toHaveClass('is-error');
    expect(
      failedRow.querySelector(
        '.conv-tool-chip-icon-slot .conv-tool-chip-kind-icon'
      )
    ).not.toBeNull();
    expect(
      failedRow.querySelector(
        '.conv-tool-chip-trailing .conv-tool-chip-chevron'
      )
    ).not.toBeNull();
  });

  it('omits terminal and edit-file labels, displays Read only for file reads, and hides duplicate mini file icons', () => {
    render(
      <TurnActivity
        turnId="turn-t3-simplified-rows"
        timestamp="2026-10-12T00:00:00.000Z"
        workspacePath="/workspace/app"
        items={[
          makeToolItem(0, 'bash', { command: 'git status --short' }, 'clean'),
          makeToolItem(1, 'Edit', {
            file_path: '/workspace/app/src/app.ts',
            old_string: 'const a = 1;',
            new_string: 'const a = 2;',
          }),
          makeToolItem(2, 'Read', {
            file_path: '/workspace/app/docs/guide.md',
          }),
        ]}
        attempt={{ id: 'ws-1', container_ref: '/workspace/app' } as never}
        task={null}
        isStreaming={false}
      />
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: '运行 1 个命令、已改 1 个文件，以及其他 1 项操作',
      })
    );
    const viewport = screen.getByTestId('turn-tool-chips-viewport');
    expect(within(viewport).queryByText('终端')).not.toBeInTheDocument();
    expect(within(viewport).queryByText('编辑文件')).not.toBeInTheDocument();
    expect(within(viewport).queryByText('查看文件')).not.toBeInTheDocument();
    expect(within(viewport).getByText('Read')).toBeInTheDocument();
    expect(
      within(viewport).getByText('git status --short')
    ).toBeInTheDocument();
    expect(within(viewport).getByText('app.ts')).toBeInTheDocument();
    expect(within(viewport).getByText('guide.md')).toBeInTheDocument();
    expect(viewport.querySelector('.dimo-tool-call-file-icon')).toBeNull();

    const rows = within(viewport).getAllByTestId('turn-tool-chip-row');
    expect(rows[0]!.querySelector('.conv-tool-chip-label')).toBeNull();
    expect(rows[1]!.querySelector('.conv-tool-chip-label')).toBeNull();
    expect(rows[2]!.querySelector('.conv-tool-chip-label')).toHaveTextContent(
      'Read'
    );
  });

  it('renders a disclosure triangle on the batch header and only shows a spinner while collapsed and running', () => {
    const items = [
      makeToolItem(0, 'bash', { command: 'cmd-0' }, 'ok'),
      makeToolItem(1, 'bash', { command: 'cmd-1' }, null),
    ];
    const { rerender } = render(
      <TurnActivity
        turnId="turn-disclosure-triangle"
        timestamp="2026-10-12T00:00:00.000Z"
        items={items}
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        isStreaming={true}
      />
    );

    const liveHeader = screen.getByRole('button', { name: 'cmd-1' });
    expect(
      within(liveHeader).queryByTestId('turn-tool-chips-disclosure')
    ).not.toBeInTheDocument();
    expect(liveHeader.querySelector('.conv-tool-chip-spinner')).not.toBeNull();

    // Expanding while still streaming switches the header icon to the disclosure triangle
    fireEvent.click(liveHeader);
    expect(
      within(liveHeader).getByTestId('turn-tool-chips-disclosure')
    ).toBeInTheDocument();
    expect(liveHeader.querySelector('.conv-tool-chip-spinner')).toBeNull();

    // Settled collapsed header also renders the disclosure triangle (never a hammer)
    fireEvent.click(liveHeader);
    rerender(
      <TurnActivity
        turnId="turn-disclosure-triangle"
        timestamp="2026-10-12T00:00:00.000Z"
        items={[
          items[0]!,
          makeToolItem(1, 'bash', { command: 'cmd-1' }, 'done'),
        ]}
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        isStreaming={false}
      />
    );
    const settledHeader = screen.getByRole('button', { name: '运行 2 个命令' });
    expect(
      within(settledHeader).getByTestId('turn-tool-chips-disclosure')
    ).toBeInTheDocument();
  });

  it('preserves viewport scrollTop when expanding and then collapsing a tool item', async () => {
    render(
      <TurnActivity
        turnId="turn-collapse-scroll-anchor"
        timestamp="2026-10-12T00:00:00.000Z"
        items={[
          makeToolItem(0, 'bash', { command: 'cmd-0' }, 'output-0'),
          makeToolItem(1, 'bash', { command: 'cmd-1' }, 'output-1'),
          makeToolItem(2, 'bash', { command: 'cmd-2' }, 'output-2'),
        ]}
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        isStreaming={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '运行 3 个命令' }));
    const viewport = screen.getByTestId('turn-tool-chips-viewport');
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      value: 520,
    });

    // User scrolls down inside the tool-call list before expanding an item
    viewport.scrollTop = 180;
    fireEvent.scroll(viewport);

    // Expand cmd-1
    const targetRow = screen.getByRole('button', { name: 'cmd-1' });
    fireEvent.click(targetRow);
    const detail = viewport.querySelector('.conv-tool-chip-detail');
    expect(detail).not.toBeNull();
    Object.defineProperty(detail, 'offsetHeight', {
      configurable: true,
      value: 160,
    });
    fireEvent.scroll(viewport);
    expect(viewport.style.getPropertyValue('--conv-batch-expanded-extra')).toBe(
      '160px'
    );
    expect(viewport.scrollTop).toBe(180);

    // Collapse cmd-1 and simulate Chromium clamping scrollTop to 0 during layout
    fireEvent.click(targetRow);
    viewport.scrollTop = 0;
    await act(async () => {
      await Promise.resolve();
    });

    expect(viewport.style.getPropertyValue('--conv-batch-expanded-extra')).toBe(
      ''
    );
    expect(viewport.scrollTop).toBe(180);
  });
});
