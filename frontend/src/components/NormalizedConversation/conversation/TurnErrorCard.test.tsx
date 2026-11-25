import { describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ConversationError } from 'shared/types';
import { TurnErrorCard } from './TurnErrorCard';

function err(overrides: Partial<ConversationError> = {}): ConversationError {
  const merged: ConversationError = {
    message: 'boom',
    code: null,
    raw: null,
    kind: 'unknown',
    ...overrides,
  };
  if (overrides.kind == null) {
    merged.kind = kindFromCode(merged.code ?? null);
  }
  return merged;
}

function kindFromCode(code: string | null): ConversationError['kind'] {
  switch (code) {
    case 'invalid_request':
    case 'invalid_params':
      return 'rejected';
    case 'internal_error':
      return 'service_error';
    case 'request_cancelled':
    case 'cancelled':
      return 'cancelled';
    case 'auth_required':
      return 'auth_required';
    case 'resource_not_found':
      return 'resource_not_found';
    case 'session_resume_unsupported':
      return 'session_resume_unsupported';
    case 'session_load_failed':
      return 'session_load_failed';
    case 'idle_timeout':
      return 'idle_timeout';
    case 'connection_closed':
    case 'agent_connection_lost':
      return 'connection_closed';
    case 'prompt_conflict':
      return 'prompt_conflict';
    default:
      return 'unknown';
  }
}

describe('TurnErrorCard', () => {
  it('treats a cancellation as a neutral notice without a reload action', () => {
    render(
      <TurnErrorCard error={err({ code: 'cancelled' })} onReload={vi.fn()} />
    );

    expect(screen.getByText('已取消')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新加载/ })).toBeNull();
  });

  it('renders an expired-session error with a rebind action', async () => {
    const onRebind = vi.fn();
    render(
      <TurnErrorCard
        error={err({ code: 'resource_not_found', message: '' })}
        onReload={vi.fn()}
        onRebind={onRebind}
      />
    );

    expect(screen.getByText('Agent 会话已过期')).toBeInTheDocument();
    const rebindButton = screen.getByRole('button', { name: /重新绑定会话/ });
    fireEvent.click(rebindButton);
    expect(onRebind).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(rebindButton).not.toBeDisabled());
  });

  it('explains an idle-timeout (agent stopped responding) with timeout seconds and reload', async () => {
    const onReload = vi.fn();
    render(
      <TurnErrorCard
        error={err({
          code: 'idle_timeout',
          message: 'Agent prompt timed out after 300s without output',
        })}
        onReload={onReload}
      />
    );

    expect(screen.getByText('Agent 长时间无响应')).toBeInTheDocument();
    expect(screen.getByText(/超过 300 秒未返回内容/)).toBeInTheDocument();
    const reloadButton = screen.getByRole('button', { name: /重新加载会话/ });
    fireEvent.click(reloadButton);
    expect(onReload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reloadButton).not.toBeDisabled());
  });

  it('explains a closed connection with localized summary and keeps raw message in details', () => {
    render(
      <TurnErrorCard
        error={err({
          code: 'connection_closed',
          message: 'Agent connection closed before the turn completed.',
        })}
        onReload={vi.fn()}
        onRetry={vi.fn()}
        placement="composer"
      />
    );

    expect(screen.getByText('Agent 连接已断开')).toBeInTheDocument();
    expect(
      screen.getByText(/Agent 进程或连接在本回合完成前中断/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Agent connection closed before the turn completed\./)
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /重新加载会话/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '手动重试' })
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: '查看详情：Agent 连接已断开' })
    );
    expect(
      screen.getByText(/Agent connection closed before the turn completed\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/错误代码：connection_closed/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '复制详情' })
    ).toBeInTheDocument();
  });

  it('maps agent_connection_lost to connection_closed with reload', () => {
    render(
      <TurnErrorCard
        error={
          {
            message:
              'Agent connection was lost and could not be re-established',
            code: 'agent_connection_lost',
            raw: null,
          } as unknown as ConversationError
        }
        onReload={vi.fn()}
      />
    );

    expect(screen.getByText('Agent 连接已断开')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /重新加载会话/ })
    ).toBeInTheDocument();
  });

  it('surfaces an auth error with retry guidance and without reload or rebind', () => {
    render(
      <TurnErrorCard
        error={err({ code: 'auth_required', message: 'login first' })}
        onReload={vi.fn()}
        onRebind={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('需要登录或重新认证')).toBeInTheDocument();
    expect(screen.getByText(/登录状态已失效或缺少凭据/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新加载/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /重新绑定/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: '手动重试' })
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: '查看详情：需要登录或重新认证' })
    );
    expect(screen.getByText(/login first/)).toBeInTheDocument();
  });

  it('strips internal prefixes in summary and keeps raw error code in details for unmapped failures', () => {
    render(
      <TurnErrorCard
        error={err({
          code: 'rpc_-32050',
          message: 'Internal error: model unavailable',
        })}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByText('本回合执行失败')).toBeInTheDocument();
    expect(screen.getByText('model unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/rpc_-32050/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: '查看详情：本回合执行失败' })
    );
    expect(
      screen.getByText(/Internal error: model unavailable/)
    ).toBeInTheDocument();
    expect(screen.getByText(/错误代码：rpc_-32050/)).toBeInTheDocument();
  });

  it('falls back to a generic error when there is no code', () => {
    render(<TurnErrorCard error={err({ message: 'something failed' })} />);

    expect(screen.getByText('本回合执行失败')).toBeInTheDocument();
    expect(screen.getByText('something failed')).toBeInTheDocument();
  });

  it('allows a timeline error to be dismissed', () => {
    const onDismiss = vi.fn();
    render(
      <TurnErrorCard
        error={err({ code: 'connection_closed' })}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid requests without offering retry', () => {
    render(
      <TurnErrorCard
        error={err({ kind: 'rejected', code: 'invalid_params' })}
        onReload={vi.fn()}
        onRebind={vi.fn()}
      />
    );

    expect(screen.getByText('请求被拒绝')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新加载/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: /重新绑定会话/ })
    ).toBeInTheDocument();
  });

  it('offers retry and reload for a service error', () => {
    render(
      <TurnErrorCard
        error={err({ kind: 'service_error', code: 'internal_error' })}
        onReload={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('模型服务异常')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '手动重试' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /重新加载会话/ })
    ).toBeInTheDocument();
  });

  it('offers retry without reload for a structured rate limit', () => {
    render(
      <TurnErrorCard
        error={err({ kind: 'rate_limited', code: 'rpc_-32000' })}
        onReload={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('已触发请求限流')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '手动重试' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新加载会话/ })).toBeNull();
  });

  it('offers retry without reload for prompt_conflict and billing quota errors', () => {
    const { rerender } = render(
      <TurnErrorCard
        error={err({ kind: 'prompt_conflict', code: 'prompt_conflict' })}
        onReload={vi.fn()}
        onRebind={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('Agent 连接正忙')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '手动重试' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新加载/ })).toBeNull();

    rerender(
      <TurnErrorCard
        error={err({ kind: 'unknown', code: 'insufficient_quota' })}
        onReload={vi.fn()}
        onRebind={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('额度不足或需检查账单')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '手动重试' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新绑定/ })).toBeNull();
  });

  it('does not classify rate-limit wording as rate_limited', () => {
    render(
      <TurnErrorCard
        error={err({
          kind: 'unknown',
          message: 'rate limit exceeded',
          code: 'rpc_-32050',
        })}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByText('本回合执行失败')).toBeInTheDocument();
    expect(screen.queryByText('已触发请求限流')).toBeNull();
  });

  it('puts composer recovery actions beside the title and replaces the icon with a localized badge', () => {
    render(
      <TurnErrorCard
        error={err({ code: 'connection_closed' })}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
        placement="composer"
      />
    );

    const title = screen.getByText('Agent 连接已断开');
    const header = title.closest('.composer-status-header');

    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText('错误')).toHaveClass(
      'astryx-badge'
    );
    expect(
      within(header as HTMLElement).getByRole('button', {
        name: /重新加载会话/,
      })
    ).toBeInTheDocument();
    expect(
      within(header as HTMLElement).getByRole('button', { name: '关闭提示' })
    ).toBeInTheDocument();
    expect(
      title
        .closest('.composer-status-row')
        ?.querySelector('.composer-status-icon')
    ).toBeNull();
  });

  it('offers manual retry alongside reload for retryable errors and omits it on non-retryable ones', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <TurnErrorCard
        error={err({ kind: 'service_error', code: 'internal_error' })}
        onReload={vi.fn()}
        onRetry={onRetry}
        placement="composer"
      />
    );

    const retryButton = screen.getByRole('button', { name: '手动重试' });
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(retryButton).not.toBeDisabled());
    expect(
      screen.getByRole('button', { name: /重新加载会话/ })
    ).toBeInTheDocument();

    rerender(
      <TurnErrorCard
        error={err({ kind: 'rejected', code: 'invalid_params' })}
        onReload={vi.fn()}
        onRebind={vi.fn()}
        onRetry={onRetry}
        placement="composer"
      />
    );
    expect(screen.queryByRole('button', { name: '手动重试' })).toBeNull();
  });
});
