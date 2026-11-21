import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnActivity } from './TurnActivity';
import type { IndexedTurnItem } from './messageTurnAggregate';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';

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

    const row = screen.getByRole('button', { name: '终端pnpm lint' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('tool-detail-entry')).not.toBeInTheDocument();

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(
      screen.getByRole('button', { name: '终端pnpm lint' })
    ).toHaveAttribute('aria-expanded', 'true');
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
    expect(screen.getAllByTestId('turn-tool-chip-row')).toHaveLength(3);
    expect(screen.getByText(/git status --short/)).toBeInTheDocument();
    expect(screen.getByText('工具调用失败')).toBeInTheDocument();
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
});
