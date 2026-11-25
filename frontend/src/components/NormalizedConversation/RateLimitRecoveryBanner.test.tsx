import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONTINUATION_PROMPT,
  RateLimitRecoveryBanner,
} from './RateLimitRecoveryBanner';

describe('RateLimitRecoveryBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when not rate-limited', () => {
    const { container } = render(
      <RateLimitRecoveryBanner
        conversationId="conv-1"
        rateLimit={{
          isRateLimited: false,
          engine: 'Codex',
          limitedAt: '2026-06-01T12:00:00.000Z',
          resetAt: '2026-06-01T12:12:34.000Z',
          autoResume: true,
        }}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders live tabular-nums countdown, toggles auto-resume, edits continuation prompt, and cancels wait', async () => {
    const onUpdateAutoResume = vi.fn().mockResolvedValue(undefined);
    const onCancelWait = vi.fn().mockResolvedValue(undefined);

    render(
      <RateLimitRecoveryBanner
        conversationId="conv-rate-1"
        rateLimit={{
          isRateLimited: true,
          engine: 'Codex',
          limitedAt: '2026-06-01T12:00:00.000Z',
          resetAt: '2026-06-01T12:12:34.000Z',
          autoResume: true,
        }}
        onUpdateAutoResume={onUpdateAutoResume}
        onCancelWait={onCancelWait}
      />
    );

    const titleEl = screen.getByTestId('rate-limit-banner-title');
    expect(titleEl).toHaveClass('tabular-nums');
    expect(titleEl).toHaveTextContent('Codex');
    expect(titleEl).toHaveTextContent('12:34');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(titleEl).toHaveTextContent('12:31');

    // Toggle auto-resume switch off
    const switchEl = screen.getByTestId('rate-limit-auto-resume-switch');
    expect(switchEl).toHaveAttribute('data-state', 'checked');
    await act(async () => {
      fireEvent.click(switchEl);
    });

    expect(switchEl).toHaveAttribute('data-state', 'unchecked');
    expect(onUpdateAutoResume).toHaveBeenCalledWith({
      conversationId: 'conv-rate-1',
      autoResume: false,
      continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
    });

    // Expand and edit continuation prompt
    fireEvent.click(screen.getByTestId('rate-limit-edit-prompt-toggle'));
    const promptInput = screen.getByTestId(
      'rate-limit-prompt-input'
    ) as HTMLInputElement;
    expect(promptInput.value).toBe(DEFAULT_CONTINUATION_PROMPT);

    fireEvent.change(promptInput, {
      target: { value: 'Continue from step 3 and run tests.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rate-limit-save-prompt-btn'));
    });

    expect(onUpdateAutoResume).toHaveBeenLastCalledWith({
      conversationId: 'conv-rate-1',
      autoResume: false,
      continuationPrompt: 'Continue from step 3 and run tests.',
    });
    expect(screen.queryByTestId('rate-limit-prompt-editor')).toBeNull();

    // Cancel wait
    await act(async () => {
      fireEvent.click(screen.getByTestId('rate-limit-cancel-btn'));
    });
    expect(onCancelWait).toHaveBeenCalledWith('conv-rate-1');
  });

  it('rolls back optimistic changes and shows toast error when update or cancel fails', async () => {
    const { toast } = await import('@/components/ui/toast');
    const toastErrorSpy = vi
      .spyOn(toast, 'error')
      .mockImplementation(() => 'err-toast');
    const onUpdateAutoResume = vi
      .fn()
      .mockRejectedValue(new Error('Update failed'));
    const onCancelWait = vi.fn().mockRejectedValue(new Error('Cancel failed'));

    try {
      render(
        <RateLimitRecoveryBanner
          conversationId="conv-rate-err"
          rateLimit={{
            isRateLimited: true,
            engine: 'Codex',
            limitedAt: '2026-06-01T12:00:00.000Z',
            resetAt: '2026-06-01T12:12:34.000Z',
            autoResume: true,
          }}
          onUpdateAutoResume={onUpdateAutoResume}
          onCancelWait={onCancelWait}
        />
      );

      const switchEl = screen.getByTestId('rate-limit-auto-resume-switch');
      expect(switchEl).toHaveAttribute('data-state', 'checked');

      await act(async () => {
        fireEvent.click(switchEl);
      });
      expect(switchEl).toHaveAttribute('data-state', 'checked');
      expect(toastErrorSpy).toHaveBeenCalledWith('Update failed');

      fireEvent.click(screen.getByTestId('rate-limit-edit-prompt-toggle'));
      const promptInput = screen.getByTestId(
        'rate-limit-prompt-input'
      ) as HTMLInputElement;
      fireEvent.change(promptInput, {
        target: { value: 'Unsaved custom prompt' },
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('rate-limit-save-prompt-btn'));
      });
      expect(
        screen.getByTestId('rate-limit-prompt-editor')
      ).toBeInTheDocument();
      expect(
        (screen.getByTestId('rate-limit-prompt-input') as HTMLInputElement)
          .value
      ).toBe('Unsaved custom prompt');
      expect(toastErrorSpy).toHaveBeenCalledTimes(2);

      await act(async () => {
        fireEvent.click(screen.getByTestId('rate-limit-cancel-btn'));
      });
      expect(toastErrorSpy).toHaveBeenCalledWith('Cancel failed');
    } finally {
      toastErrorSpy.mockRestore();
    }
  });

  it('formats raw snake_case engine identifiers into human-readable labels', () => {
    render(
      <RateLimitRecoveryBanner
        conversationId="conv-rate-engine"
        rateLimit={{
          isRateLimited: true,
          engine: 'claude_code',
          limitedAt: '2026-06-01T12:00:00.000Z',
          resetAt: '2026-06-01T12:05:00.000Z',
          autoResume: true,
        }}
      />
    );

    const titleEl = screen.getByTestId('rate-limit-banner-title');
    expect(titleEl).toHaveTextContent('Claude Code');
    expect(titleEl).not.toHaveTextContent('claude_code');
  });

  it('preserves active continuation prompt edits when rateLimit refreshes with new object references', () => {
    const { rerender } = render(
      <RateLimitRecoveryBanner
        conversationId="conv-edit-1"
        rateLimit={{
          isRateLimited: true,
          engine: 'Codex',
          limitedAt: '2026-06-01T12:00:00.000Z',
          resetAt: '2026-06-01T12:12:34.000Z',
          autoResume: true,
          continuationPrompt: 'Initial prompt',
        }}
      />
    );

    fireEvent.click(screen.getByTestId('rate-limit-edit-prompt-toggle'));
    const input = screen.getByTestId(
      'rate-limit-prompt-input'
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'Draft currently being typed' },
    });

    // Re-render with a new rateLimit object reference (same prompt)
    rerender(
      <RateLimitRecoveryBanner
        conversationId="conv-edit-1"
        rateLimit={{
          isRateLimited: true,
          engine: 'Codex',
          limitedAt: '2026-06-01T12:00:00.000Z',
          resetAt: '2026-06-01T12:12:30.000Z',
          autoResume: true,
          continuationPrompt: 'Initial prompt',
        }}
      />
    );
    expect(
      (screen.getByTestId('rate-limit-prompt-input') as HTMLInputElement).value
    ).toBe('Draft currently being typed');

    // Re-render with a server-refreshed continuationPrompt while still editing
    rerender(
      <RateLimitRecoveryBanner
        conversationId="conv-edit-1"
        rateLimit={{
          isRateLimited: true,
          engine: 'Codex',
          limitedAt: '2026-06-01T12:00:00.000Z',
          resetAt: '2026-06-01T12:12:25.000Z',
          autoResume: true,
          continuationPrompt: 'Refreshed server prompt',
        }}
      />
    );
    expect(
      (screen.getByTestId('rate-limit-prompt-input') as HTMLInputElement).value
    ).toBe('Draft currently being typed');
  });

  it('does not roll back another conversation state when a previous conversation update rejects after switching', async () => {
    const { toast } = await import('@/components/ui/toast');
    const toastErrorSpy = vi
      .spyOn(toast, 'error')
      .mockImplementation(() => 'err-toast');
    let rejectFirstUpdate: (error: Error) => void = () => {};
    const onUpdateAutoResume = vi.fn().mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstUpdate = reject;
        })
    );

    try {
      const { rerender } = render(
        <RateLimitRecoveryBanner
          conversationId="conv-a"
          rateLimit={{
            isRateLimited: true,
            engine: 'Codex',
            limitedAt: '2026-06-01T12:00:00.000Z',
            resetAt: '2026-06-01T12:12:34.000Z',
            autoResume: true,
            continuationPrompt: 'Prompt A',
          }}
          onUpdateAutoResume={onUpdateAutoResume}
        />
      );

      // Toggle auto-resume off on conv-a while request stays in flight
      fireEvent.click(screen.getByTestId('rate-limit-auto-resume-switch'));

      // Switch to conv-b with autoResume: false and its own prompt
      rerender(
        <RateLimitRecoveryBanner
          conversationId="conv-b"
          rateLimit={{
            isRateLimited: true,
            engine: 'Codex',
            limitedAt: '2026-06-01T12:00:00.000Z',
            resetAt: '2026-06-01T12:15:00.000Z',
            autoResume: false,
            continuationPrompt: 'Prompt B',
          }}
          onUpdateAutoResume={onUpdateAutoResume}
        />
      );

      expect(
        screen.getByTestId('rate-limit-auto-resume-switch')
      ).toHaveAttribute('data-state', 'unchecked');

      // Now reject conv-a's in-flight request
      await act(async () => {
        rejectFirstUpdate(new Error('conv-a failed'));
        await Promise.resolve();
      });

      // conv-b must NOT be rolled back to conv-a's previous autoResume=true or prompt
      expect(
        screen.getByTestId('rate-limit-auto-resume-switch')
      ).toHaveAttribute('data-state', 'unchecked');
      fireEvent.click(screen.getByTestId('rate-limit-edit-prompt-toggle'));
      expect(
        (screen.getByTestId('rate-limit-prompt-input') as HTMLInputElement)
          .value
      ).toBe('Prompt B');
      expect(toastErrorSpy).not.toHaveBeenCalled();
    } finally {
      toastErrorSpy.mockRestore();
    }
  });
});
