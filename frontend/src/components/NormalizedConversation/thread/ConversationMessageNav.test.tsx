import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationMessageNav,
  resolveScrubEntryIndex,
} from './ConversationMessageNav';

describe('ConversationMessageNav', () => {
  it('highlights the active anchor and calls onSelect with the virtual row index', () => {
    const onSelect = vi.fn();

    render(
      <ConversationMessageNav
        activeIndex={5}
        onSelect={onSelect}
        entries={[
          {
            key: 'first',
            index: 0,
            ordinal: 1,
            preview: 'First request',
            additions: 0,
            deletions: 0,
          },
          {
            key: 'second',
            index: 4,
            ordinal: 2,
            preview: 'Second request',
            additions: 3,
            deletions: 1,
          },
        ]}
      />
    );

    expect(
      screen.getByRole('button', { name: '跳转到第 2 条消息' })
    ).toHaveAttribute('aria-current', 'true');

    fireEvent.click(screen.getByRole('button', { name: '跳转到第 1 条消息' }));

    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('shows a two-line message preview to the left when a tick is hovered', async () => {
    const user = userEvent.setup();

    render(
      <ConversationMessageNav
        activeIndex={0}
        onSelect={vi.fn()}
        entries={[
          {
            key: 'first',
            index: 0,
            ordinal: 1,
            preview: 'Please polish the conversation monitor layout',
            additions: 0,
            deletions: 0,
          },
        ]}
      />
    );

    const tick = screen.getByRole('button', {
      name: '跳转到第 1 条消息',
    });
    await user.hover(tick);

    const previews = await screen.findAllByText(
      'Please polish the conversation monitor layout'
    );
    const preview = previews.find((element) =>
      element.classList.contains('conv-message-nav-preview')
    );

    expect(preview).toBeDefined();
    expect(preview).toHaveClass('conv-message-nav-preview');
    expect(preview).toHaveAttribute('data-side', 'left');
  });

  it('scrubs continuously across ticks via rAF without layout thrashing on 500+ turns', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
    const cancelRafSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {});

    const entries = Array.from({ length: 500 }, (_, i) => ({
      key: `turn-${i + 1}`,
      index: i * 2,
      ordinal: i + 1,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      preview: `Turn ${i + 1} summary message`,
      additions: 0,
      deletions: 0,
    }));

    const onSelect = vi.fn();
    render(
      <ConversationMessageNav
        activeIndex={0}
        onSelect={onSelect}
        entries={entries}
      />
    );

    const list = screen.getByTestId('conv-message-nav-list');
    const getRectSpy = vi
      .spyOn(list, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(900, 100, 22, 500));

    fireEvent.pointerDown(list, { button: 0, pointerId: 1, clientY: 105 });
    expect(getRectSpy).toHaveBeenCalledTimes(1);

    // Burst multiple pointermove events within a single animation frame -> coalesced into 1 rAF
    fireEvent.pointerMove(list, { pointerId: 1, clientY: 180 });
    fireEvent.pointerMove(list, { pointerId: 1, clientY: 350 });
    expect(rafCallbacks).toHaveLength(1);
    // Zero extra getBoundingClientRect() calls during pointermove
    expect(getRectSpy).toHaveBeenCalledTimes(1);

    act(() => {
      const cb = rafCallbacks.shift();
      cb?.(16.6);
    });

    // clientY=350 on [100..600] -> ratio 0.5 -> entryIndex 250 (ordinal #251, timeline index 500)
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(500);

    const scrubTooltip = screen.getByTestId('conv-message-nav-scrub-preview');
    expect(scrubTooltip).toHaveTextContent('#251');
    expect(scrubTooltip).toHaveTextContent('Turn 251 summary message');

    // Release pointer -> scrub tooltip dismisses cleanly
    fireEvent.pointerUp(list, { pointerId: 1, clientY: 350 });
    expect(screen.queryByTestId('conv-message-nav-scrub-preview')).toBeNull();

    expect(
      resolveScrubEntryIndex({
        clientY: 599,
        rectTop: 100,
        rectHeight: 500,
        entryCount: 500,
      })
    ).toBe(499);

    rafSpy.mockRestore();
    cancelRafSpy.mockRestore();
  });

  it('does not capture pointer on plain press-and-click without drag', () => {
    const onSelect = vi.fn();
    render(
      <ConversationMessageNav
        activeIndex={0}
        onSelect={onSelect}
        entries={[
          {
            key: 'first',
            index: 0,
            ordinal: 1,
            preview: 'First request',
            additions: 0,
            deletions: 0,
          },
          {
            key: 'second',
            index: 4,
            ordinal: 2,
            preview: 'Second request',
            additions: 0,
            deletions: 0,
          },
        ]}
      />
    );

    const list = screen.getByTestId('conv-message-nav-list');
    const captureSpy = vi.fn();
    list.setPointerCapture = captureSpy;
    const tick = screen.getByRole('button', { name: '跳转到第 2 条消息' });

    fireEvent.pointerDown(tick, { button: 0, pointerId: 2, clientY: 200 });
    expect(captureSpy).not.toHaveBeenCalled();
    fireEvent.pointerUp(tick, { pointerId: 2, clientY: 200 });
    fireEvent.click(tick);

    expect(onSelect).toHaveBeenCalledWith(4);
  });

  it('clears pointer session on window pointerup and ignores hover moves with no button pressed', () => {
    const onSelect = vi.fn();
    render(
      <ConversationMessageNav
        activeIndex={0}
        onSelect={onSelect}
        entries={[
          {
            key: 'first',
            index: 0,
            ordinal: 1,
            preview: 'First request',
            additions: 0,
            deletions: 0,
          },
          {
            key: 'second',
            index: 4,
            ordinal: 2,
            preview: 'Second request',
            additions: 0,
            deletions: 0,
          },
        ]}
      />
    );

    const list = screen.getByTestId('conv-message-nav-list');
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(900, 100, 22, 200)
    );

    // Press inside rail, then release outside the rail (only window sees pointerup).
    fireEvent.pointerDown(list, {
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      clientY: 110,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: 'mouse',
      clientY: 110,
    });

    // Moving the mouse back across the rail later without holding primary button must not scrub.
    fireEvent.pointerMove(list, {
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 0,
      clientY: 280,
    });
    expect(screen.queryByTestId('conv-message-nav-scrub-preview')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    // Even if window pointerup were somehow missed, a mouse move with buttons=0 ends the stale session.
    fireEvent.pointerDown(list, {
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      clientY: 110,
    });
    fireEvent.pointerMove(list, {
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 0,
      clientY: 280,
    });
    expect(screen.queryByTestId('conv-message-nav-scrub-preview')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('treats small pointer jitter during click as a click rather than a scrub drag', () => {
    const onSelect = vi.fn();
    render(
      <ConversationMessageNav
        activeIndex={0}
        onSelect={onSelect}
        entries={[
          {
            key: 'first',
            index: 0,
            ordinal: 1,
            preview: 'First request',
            additions: 0,
            deletions: 0,
          },
          {
            key: 'second',
            index: 4,
            ordinal: 2,
            preview: 'Second request',
            additions: 0,
            deletions: 0,
          },
        ]}
      />
    );

    const list = screen.getByTestId('conv-message-nav-list');
    const captureSpy = vi.fn();
    list.setPointerCapture = captureSpy;
    const tick = screen.getByRole('button', { name: '跳转到第 2 条消息' });

    fireEvent.pointerDown(tick, {
      button: 0,
      buttons: 1,
      pointerId: 3,
      pointerType: 'mouse',
      clientY: 200,
    });
    fireEvent.pointerMove(tick, {
      buttons: 1,
      pointerId: 3,
      pointerType: 'mouse',
      clientY: 203,
    });
    expect(captureSpy).not.toHaveBeenCalled();
    fireEvent.pointerUp(tick, { pointerId: 3, clientY: 203 });
    fireEvent.click(tick);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(4);
  });
});
