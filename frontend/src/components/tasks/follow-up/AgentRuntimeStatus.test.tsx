import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntimeStatus } from './AgentRuntimeStatus';
import type { ConversationSessionNotice } from 'shared/types';
const notice: ConversationSessionNotice = {
  title: 'Agent request',
  severity: 'info',
  request_status: {
    turn_id: 't',
    prompt_id: 'p',
    connection_id: 'c',
    since: '2026-11-13T00:00:00Z',
    activity: {
      phase: 'retrying',
      retry: {
        attempt: 2,
        max_attempts: 5,
        delay_ms: 3000n,
        reason: 'provider unavailable',
        code: null,
      },
    },
  },
};
describe('AgentRuntimeStatus', () => {
  afterEach(() => vi.useRealTimers());
  it('offers cancellation while retrying and manual retry only after failure', async () => {
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = render(
      <AgentRuntimeStatus
        notice={notice}
        onCancel={onCancel}
        onRetry={onRetry}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '手动重试' })).toBeNull();
    rerender(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'cancelling', retry: null },
          },
        }}
        onCancel={onCancel}
        onRetry={onRetry}
      />
    );
    expect(screen.queryByRole('button', { name: '取消请求' })).toBeNull();
    rerender(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'failed', retry: null },
          },
        }}
        onCancel={onCancel}
        onRetry={onRetry}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '手动重试' }));
    });
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it('updates a retry in place and exposes the actual reason', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
    const { rerender, container } = render(
      <AgentRuntimeStatus notice={notice} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('请求重试中');
    fireEvent.click(
      screen.getByRole('button', { name: '查看详情: 请求重试中' })
    );
    expect(screen.getByText('provider unavailable')).toBeVisible();
    rerender(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'waiting_agent', retry: null },
          },
        }}
      />
    );
    expect(screen.queryByText('provider unavailable')).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-testid="agent-request-status"]')
    ).toHaveLength(1);
  });
  it('shows elapsed response wait but stops the timer at terminal', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:00:31Z'));
    const { rerender } = render(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'waiting_agent', retry: null },
          },
        }}
      />
    );
    expect(screen.getByText('31s')).toBeVisible();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('32s')).toBeVisible();
    rerender(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'failed', retry: null },
          },
        }}
      />
    );
    expect(screen.queryByText('32s')).not.toBeInTheDocument();
  });

  it('renders lightweight animated icon and retry count inside the message stream without a card background', () => {
    render(
      <AgentRuntimeStatus
        placement="stream"
        titleOverride="会话加载异常，正在重连 2/10 次…"
        notice={{
          title: 'Agent connection',
          severity: 'warning',
          connection_status: {
            status: 'recovering',
            bound: false,
            connection_id: 'conn-1',
            message: null,
            since: '2026-11-13T00:00:00Z',
          },
        }}
        onCancel={vi.fn()}
      />
    );

    const indicator = screen.getByTestId('agent-connection-status');
    expect(indicator).toHaveAttribute('data-placement', 'stream');
    expect(indicator).toHaveClass('conv-thinking-placeholder');
    expect(indicator).not.toHaveClass('rounded-lg');
    expect(indicator.closest('.conv-entry-item')).not.toBeNull();
    expect(indicator.querySelector('.conv-pixel-grid')).not.toBeNull();
    const label = indicator.querySelector('.conv-shimmer-text');
    expect(label).toHaveClass('tabular-nums');
    expect(label).toHaveTextContent('连接中... 正在重试 2/10 次');
    expect(screen.queryByRole('button', { name: '取消请求' })).toBeNull();
  });

  it('renders lightweight connecting and retry copy for active request status in the stream', () => {
    const { rerender } = render(
      <AgentRuntimeStatus
        placement="stream"
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'waiting_agent', retry: null },
          },
        }}
      />
    );

    const waiting = screen.getByTestId('agent-request-status');
    expect(waiting).toHaveClass('conv-thinking-placeholder');
    expect(waiting).toHaveTextContent('连接中...');

    rerender(<AgentRuntimeStatus placement="stream" notice={notice} />);
    expect(screen.getByTestId('agent-request-status')).toHaveTextContent(
      '连接中... 正在重试 2/5 次'
    );
  });

  it('shows a cancelled stream status without a spinner', () => {
    render(
      <AgentRuntimeStatus
        placement="stream"
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'cancelled', retry: null },
          },
        }}
      />
    );

    const status = screen.getByTestId('agent-request-status');
    expect(status).toHaveTextContent('已取消');
    expect(status.querySelector('.conv-pixel-grid')).toBeNull();
  });

  it('uses composer-status-row classes when rendered above the composer', () => {
    render(
      <AgentRuntimeStatus
        placement="composer"
        notice={{
          title: 'Agent connection',
          severity: 'info',
          connection_status: {
            status: 'connecting',
            bound: false,
            connection_id: null,
            message: null,
            since: '2026-11-13T00:00:00Z',
          },
        }}
        onCancel={vi.fn()}
      />
    );

    const card = screen.getByTestId('agent-connection-status');
    expect(card).toHaveAttribute('data-placement', 'composer');
    expect(card).toHaveClass('composer-status-row');
    expect(
      screen.getByRole('button', { name: '取消请求' }).parentElement
    ).toHaveClass('composer-status-action-slot');
  });

  it('humanizes internal connection messages as a summary and tucks raw text behind details', () => {
    render(
      <AgentRuntimeStatus
        placement="composer"
        titleOverride="会话加载异常，正在重连 3/10 次…"
        notice={{
          title: 'Agent connection',
          severity: 'warning',
          connection_status: {
            status: 'recovering',
            bound: false,
            connection_id: 'conn-1',
            message: 'agent session retired after cancel was not acknowledged',
            since: '2026-11-13T00:00:00Z',
          },
        }}
      />
    );

    const card = screen.getByTestId('agent-connection-status');
    expect(card).toHaveTextContent('连接中断，正在自动重连（3/10）');
    expect(card).toHaveTextContent('取消请求超时，已重置 Agent 连接');
    expect(
      screen.queryByText(
        'agent session retired after cancel was not acknowledged'
      )
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: '查看详情: 连接中断，正在自动重连（3/10）',
      })
    );
    expect(
      screen.getByText(
        'agent session retired after cancel was not acknowledged'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '复制详情' })
    ).toBeInTheDocument();
  });

  it('shows live elapsed duration, retry backoff countdown, concise reason, and 30s long-wait hint in stream mode', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:00:01Z'));

    const { rerender } = render(
      <AgentRuntimeStatus
        placement="stream"
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            since: '2026-11-13T00:00:00Z',
            activity: {
              phase: 'retrying',
              retry: {
                attempt: 2,
                max_attempts: 5,
                delay_ms: 4000n,
                reason: 'upstream rate limited',
                code: '429',
              },
            },
          },
        }}
      />
    );

    expect(screen.getByTestId('agent-request-status')).toHaveTextContent(
      '连接中... 正在重试 2/5 次'
    );
    expect(screen.getByTestId('stream-retry-backoff')).toHaveTextContent(
      '3s 后重试'
    );
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent('1s');
    expect(screen.getByTestId('stream-retry-reason')).toHaveTextContent(
      'upstream rate limited (429)'
    );

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByTestId('stream-retry-backoff')).toHaveTextContent(
      '1s 后重试'
    );
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent('3s');

    // Waiting model phase after 31s shows dedicated label + elapsed + gentle long-wait reassurance.
    vi.setSystemTime(new Date('2026-11-13T00:00:31Z'));
    rerender(
      <AgentRuntimeStatus
        placement="stream"
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            since: '2026-11-13T00:00:00Z',
            activity: {
              phase: 'waiting_model',
              retry: null,
            },
          },
        }}
      />
    );

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTestId('agent-request-status')).toHaveTextContent(
      '等待模型响应...'
    );
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent('32s');
    expect(screen.getByTestId('stream-long-wait')).toHaveTextContent(
      '仍在等待，可随时取消'
    );
    expect(screen.queryByTestId('stream-retry-reason')).toBeNull();
  });
});
