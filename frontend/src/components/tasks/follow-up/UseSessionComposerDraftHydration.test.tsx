import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type DraftFollowUpData } from 'shared/types';
import { useSessionComposerDraftHydration } from './useSessionComposerDraftHydration';
import type { SessionComposerImageAttachment } from './sessionComposerImages';

const draftData: DraftFollowUpData = {
  message: 'stored draft',
  images: ['.vibe-images/one.png', '.vibe-images/two.png'],
  executor_config: { executor: 'codex' as const },
  queued: false,
  config_overrides: {},
};

function renderDraftHydrationHook(initialProps: {
  scratchId: string | undefined;
  isScratchLoading: boolean;
  scratchData: DraftFollowUpData | undefined;
  initialMessage?: string;
  initialImages?: SessionComposerImageAttachment[];
  allowSessionControlsHydration?: boolean;
  cancelDebouncedSave?: () => void;
  deleteScratch?: () => Promise<void>;
}) {
  return renderHook(
    (props: typeof initialProps) => {
      const [message, setMessage] = useState(props.initialMessage ?? '');
      const [images, setImages] = useState<SessionComposerImageAttachment[]>(
        props.initialImages ?? []
      );
      const [selectedMode, setSelectedMode] = useState<string | null>(null);
      const [selectedConfigValues, setSelectedConfigValues] = useState<
        Record<string, string>
      >({});
      const { handleAfterSendCleanup } = useSessionComposerDraftHydration({
        scratchId: props.scratchId,
        isScratchLoading: props.isScratchLoading,
        scratchData: props.scratchData,
        setLocalMessage: setMessage,
        setAttachedImages: setImages,
        setSelectedMode,
        setSelectedConfigValues,
        allowSessionControlsHydration: props.allowSessionControlsHydration,
        cancelDebouncedSave: props.cancelDebouncedSave ?? vi.fn(),
        deleteScratch: props.deleteScratch ?? vi.fn(),
      });

      return {
        message,
        images,
        selectedMode,
        selectedConfigValues,
        handleAfterSendCleanup,
      };
    },
    { initialProps }
  );
}

describe('useSessionComposerDraftHydration', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('suppresses draft hydration while scratch is loading', () => {
    const { result } = renderDraftHydrationHook({
      scratchId: 'session-1',
      isScratchLoading: true,
      scratchData: draftData,
    });

    expect(result.current.message).toBe('');
    expect(result.current.images).toEqual([]);
  });

  it('hydrates message and image attachments only once per scratch id', () => {
    const revokeSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const previousImage = {
      id: 'previous',
      name: 'previous.png',
      path: '.vibe-images/previous.png',
      previewUrl: 'blob:previous',
    };
    const { result, rerender } = renderDraftHydrationHook({
      scratchId: 'session-1',
      isScratchLoading: false,
      scratchData: draftData,
      initialImages: [previousImage],
    });

    expect(result.current.message).toBe('stored draft');
    expect(result.current.images.map((image) => image.path)).toEqual([
      '.vibe-images/one.png',
      '.vibe-images/two.png',
    ]);
    expect(revokeSpy).toHaveBeenCalledWith('blob:previous');

    rerender({
      scratchId: 'session-1',
      isScratchLoading: false,
      scratchData: {
        ...draftData,
        message: 'changed scratch payload',
      },
      initialImages: [previousImage],
    });

    expect(result.current.message).toBe('stored draft');
    revokeSpy.mockRestore();
  });

  it('skips stale draft mode and config overrides for established sessions while still hydrating text', () => {
    const { result } = renderDraftHydrationHook({
      scratchId: 'session-established',
      isScratchLoading: false,
      allowSessionControlsHydration: false,
      scratchData: {
        ...draftData,
        mode_override: 'plan',
        config_overrides: { model: 'stale-model' },
      },
    });

    expect(result.current.message).toBe('stored draft');
    expect(result.current.selectedMode).toBeNull();
    expect(result.current.selectedConfigValues).toEqual({});
  });

  it('hydrates draft mode and config overrides before a session has established controls', () => {
    const { result } = renderDraftHydrationHook({
      scratchId: 'session-fresh',
      isScratchLoading: false,
      allowSessionControlsHydration: true,
      scratchData: {
        ...draftData,
        mode_override: 'acceptEdits',
        config_overrides: { model: 'claude-opus-4-6' },
      },
    });

    expect(result.current.selectedMode).toBe('acceptEdits');
    expect(result.current.selectedConfigValues).toEqual({
      model: 'claude-opus-4-6',
    });
  });

  it('cleans local draft state after send and deletes existing scratch', async () => {
    const cancelDebouncedSave = vi.fn();
    const deleteScratch = vi.fn().mockResolvedValue(undefined);
    const revokeSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const { result } = renderDraftHydrationHook({
      scratchId: 'session-1',
      isScratchLoading: false,
      scratchData: undefined,
      initialMessage: 'sent message',
      initialImages: [
        {
          id: 'image-1',
          name: 'image.png',
          path: '.vibe-images/image.png',
          previewUrl: 'blob:image',
        },
      ],
      cancelDebouncedSave,
      deleteScratch,
    });

    await act(async () => {
      await result.current.handleAfterSendCleanup();
    });

    expect(cancelDebouncedSave).toHaveBeenCalledOnce();
    expect(result.current.message).toBe('');
    expect(result.current.images).toEqual([]);
    expect(revokeSpy).toHaveBeenCalledWith('blob:image');
    expect(deleteScratch).toHaveBeenCalledOnce();
    revokeSpy.mockRestore();
  });

  it('skips scratch deletion after send when there is no scratch id', async () => {
    const deleteScratch = vi.fn().mockResolvedValue(undefined);
    const { result } = renderDraftHydrationHook({
      scratchId: undefined,
      isScratchLoading: false,
      scratchData: undefined,
      deleteScratch,
    });

    await act(async () => {
      await result.current.handleAfterSendCleanup();
    });

    expect(deleteScratch).not.toHaveBeenCalled();
  });
});
