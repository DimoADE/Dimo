import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from 'shared/types';
import i18n from '@/i18n';
import { TurnActivity } from './TurnActivity';
import { planTurnBlocks } from './messageTurnBlocks';

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => null,
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({ config: { theme: 'light' } }),
  useOptionalUserSystem: () => ({ config: { theme: 'light' } }),
}));

vi.mock('@/components/common/RawLogText', () => ({
  default: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

vi.mock('./AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => <pre>{value}</pre>,
}));

const INITIAL_LANGUAGE = i18n.language;

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage(INITIAL_LANGUAGE);
});

function renderCommand({
  id,
  status = 'failed',
  code,
  backgrounded = false,
  outputPreview,
}: {
  id: string;
  status?: 'failed' | 'completed' | 'in_progress' | 'denied' | 'timed_out';
  code?: number;
  backgrounded?: boolean;
  outputPreview?: string;
}) {
  const blocks: ContentBlock[] = [
    {
      type: 'tool_use',
      tool_use_id: id,
      tool_name: 'exec_command',
      kind: 'execute',
      status,
      input_preview: JSON.stringify({ cmd: 'powershell.exe -Command test' }),
      meta: backgrounded ? { asyncTasks: { backgrounded: true } } : null,
    },
  ];
  if (status !== 'in_progress') {
    blocks.push({
      type: 'tool_result',
      tool_use_id: id,
      is_error:
        status === 'failed' || status === 'denied' || status === 'timed_out',
      output_preview:
        outputPreview ??
        JSON.stringify({
          stdout: 'original stdout',
          stderr: 'original stderr',
          ...(code !== undefined ? { exit_code: code } : {}),
        }),
    });
  }
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TurnActivity
        turnId={id}
        timestamp="2026-11-18T00:00:00.000Z"
        items={planTurnBlocks(blocks).map((item, index) => ({ item, index }))}
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    </QueryClientProvider>
  );
  if (!screen.queryByTestId('turn-tool-chip-row')) {
    fireEvent.click(
      screen.getByRole('button', { name: /运行 1 个命令|Ran 1 command/ })
    );
  }
  return view;
}

describe('terminal failure summaries in the timeline', () => {
  it('marks nonzero exit code as error with tooltip without a right-side badge and preserves output on expansion', () => {
    renderCommand({ id: 'exit-23', code: 23 });
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveClass('is-error');
    expect(row).toHaveAttribute('title', '命令退出码 23');
    expect(screen.queryByText('命令退出码 23')).not.toBeInTheDocument();
    expect(screen.queryByText('工具调用失败')).not.toBeInTheDocument();
    expect(document.querySelector('.conv-tool-chip-error-badge')).toBeNull();
    expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
      'data-tool-status',
      'error'
    );
    fireEvent.click(row);
    expect(screen.getByText(/original stdout/)).toBeVisible();
    expect(screen.getByText(/original stderr/)).toBeVisible();
    expect(screen.getByText('exit 23')).toBeVisible();
  });

  it('uses the command result when the transport reports completion', () => {
    renderCommand({ id: 'completed-exit-1', status: 'completed', code: 1 });
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(row).toHaveClass('is-error');
    expect(row).toHaveAttribute('title', '命令退出码 1');
    expect(screen.queryByText('命令退出码 1')).not.toBeInTheDocument();
    expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
      'data-tool-status',
      'error'
    );
  });

  it('records timeout summary in tooltip even if killed with an exit code, and preserves output on expansion', async () => {
    renderCommand({ id: 'timeout-124', status: 'timed_out', code: 124 });
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(row).toHaveClass('is-error');
    expect(row).toHaveAttribute('title', '执行超时');
    expect(screen.queryByText('执行超时')).not.toBeInTheDocument();
    expect(screen.queryByText('工具调用失败')).not.toBeInTheDocument();
    expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
      'data-tool-status',
      'error'
    );
    fireEvent.click(row);
    expect(screen.getByText(/original stdout/)).toBeVisible();
    expect(screen.getByText('exit 124')).toBeVisible();

    cleanup();
    await i18n.changeLanguage('en');
    renderCommand({
      id: 'timeout-en',
      status: 'failed',
      outputPreview: JSON.stringify({ timedOut: true, stdout: 'partial' }),
    });
    expect(screen.getByTestId('turn-tool-chip-row')).toHaveAttribute(
      'title',
      'Timed out'
    );
  });

  it('records permission denied summary in tooltip and localizes in English', async () => {
    renderCommand({ id: 'denied-zh', status: 'denied' });
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(row).toHaveClass('is-error');
    expect(row).toHaveAttribute('title', '权限被拒绝');
    expect(screen.queryByText('权限被拒绝')).not.toBeInTheDocument();
    expect(screen.queryByText('工具调用失败')).not.toBeInTheDocument();
    expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
      'data-tool-status',
      'error'
    );
    fireEvent.click(row);
    expect(screen.getByText(/original stdout/)).toBeVisible();

    cleanup();
    await i18n.changeLanguage('en');
    renderCommand({
      id: 'denied-en',
      status: 'failed',
      outputPreview: JSON.stringify({ status: 'declined', stdout: 'declined' }),
    });
    expect(screen.getByTestId('turn-tool-chip-row')).toHaveAttribute(
      'title',
      'Permission denied'
    );
  });

  it.each([
    ['successful', 'completed', 0, false, 'complete'],
    ['running', 'in_progress', undefined, false, 'running'],
    ['background', 'failed', 23, true, 'complete'],
  ] as const)(
    'does not invent a failure for %s commands',
    (id, status, code, backgrounded, expected) => {
      renderCommand({ id, status, code, backgrounded });
      expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
        'data-tool-status',
        expected
      );
      expect(screen.getByTestId('turn-tool-chip-row')).not.toHaveAttribute(
        'title'
      );
      expect(
        screen.queryByText(/命令退出码|工具调用失败|执行超时|权限被拒绝/)
      ).not.toBeInTheDocument();
    }
  );

  it('keeps an unknown failure generic instead of guessing from prose output or inventing an exit code', () => {
    renderCommand({
      id: 'unknown-failure',
      outputPreview: 'Permission denied',
    });
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(row).toHaveClass('is-error');
    expect(row).toHaveAttribute('title', '工具调用失败');
    expect(
      screen.queryByText(/命令退出码|权限被拒绝|执行超时/)
    ).not.toBeInTheDocument();
  });

  it('localizes the reported exit code tooltip in English', async () => {
    await i18n.changeLanguage('en');
    renderCommand({ id: 'english-exit', code: 7 });
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(row).toHaveAttribute('title', 'Command exited with code 7');
    expect(
      screen.queryByText('Command exited with code 7')
    ).not.toBeInTheDocument();
  });
});
