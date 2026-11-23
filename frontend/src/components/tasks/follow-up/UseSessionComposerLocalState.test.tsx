import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEventEnvelope,
  AgentSessionConfigOption,
  ExecutorProfileId,
} from 'shared/types';

const {
  setSessionModeMock,
  setSessionConfigOptionMock,
  listenToAgentEventsMock,
  toastErrorMock,
  toastWarningMock,
} = vi.hoisted(() => ({
  setSessionModeMock: vi.fn(),
  setSessionConfigOptionMock: vi.fn(),
  listenToAgentEventsMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastWarningMock: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: toastErrorMock,
    warning: toastWarningMock,
  },
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: {
    setSessionMode: setSessionModeMock,
    setSessionConfigOption: setSessionConfigOptionMock,
  },
}));

vi.mock('@/features/agents/events', () => ({
  listenToAgentEvents: listenToAgentEventsMock,
}));

import {
  useSessionComposerControlSync,
  useSessionComposerLocalState,
  useSessionComposerProfileSelection,
} from './useSessionComposerLocalState';

const codexProfile: ExecutorProfileId = { executor: 'codex' as const };
const claudeProfile: ExecutorProfileId = {
  executor: 'claude_code' as const,
};
type ProfileProps = { defaultProfile: ExecutorProfileId | null };

describe('useSessionComposerLocalState', () => {
  beforeEach(() => {
    setSessionModeMock.mockReset();
    setSessionConfigOptionMock.mockReset();
    listenToAgentEventsMock.mockReset();
    toastErrorMock.mockReset();
    toastWarningMock.mockReset();
    listenToAgentEventsMock.mockResolvedValue(() => {});
  });

  it('starts with empty draft and attachments', () => {
    const { result } = renderHook(() => useSessionComposerLocalState());

    expect(result.current.localMessage).toBe('');
    expect(result.current.attachedImages).toEqual([]);
    expect(result.current.attachedImagePaths).toEqual([]);
    expect(result.current.executorProfileRef.current).toBeNull();
  });

  it('derives image paths from attached image state', () => {
    const { result } = renderHook(() => useSessionComposerLocalState());

    act(() => {
      result.current.setAttachedImages([
        {
          id: 'image-1',
          name: 'first.png',
          path: 'vibe://image/first.png',
        },
        {
          id: 'image-2',
          name: 'second.png',
          path: 'vibe://image/second.png',
        },
      ]);
    });

    expect(result.current.attachedImagePaths).toEqual([
      'vibe://image/first.png',
      'vibe://image/second.png',
    ]);
  });

  it('keeps an explicit selected executor profile across default changes', () => {
    const initialProps: ProfileProps = { defaultProfile: codexProfile };
    const { result, rerender } = renderHook(
      ({ defaultProfile }: ProfileProps) =>
        useSessionComposerProfileSelection(defaultProfile),
      { initialProps }
    );

    act(() => {
      result.current.setSelectedExecutorProfile(claudeProfile);
    });

    rerender({ defaultProfile: null });

    expect(result.current.selectedExecutorProfile).toEqual(claudeProfile);
    expect(result.current.effectiveExecutorProfile).toEqual(claudeProfile);
  });

  it('falls back to the latest default when no profile is selected', () => {
    const initialProps: ProfileProps = { defaultProfile: codexProfile };
    const { result, rerender } = renderHook(
      ({ defaultProfile }: ProfileProps) =>
        useSessionComposerProfileSelection(defaultProfile),
      { initialProps }
    );

    act(() => {
      result.current.setSelectedExecutorProfile(null);
    });

    rerender({ defaultProfile: claudeProfile });

    expect(result.current.selectedExecutorProfile).toBeNull();
    expect(result.current.effectiveExecutorProfile).toEqual(claudeProfile);
  });

  it('rolls back optimistic mode and config selections and shows toast.error when RPC fails', async () => {
    setSessionModeMock.mockRejectedValueOnce(new Error('DB write failed'));
    setSessionConfigOptionMock.mockRejectedValueOnce(
      new Error('Invalid model option')
    );

    const modelOption: AgentSessionConfigOption = {
      key: 'model',
      label: 'Model',
      description: null,
      category: 'model',
      value: 'sonnet',
      choices: [
        { value: 'sonnet', label: 'Sonnet', description: null },
        { value: 'opus', label: 'Opus', description: null },
      ],
      dependency: null,
    };

    const { result } = renderHook(() => {
      const [selectedMode, setSelectedMode] = useState<string | null>(null);
      const [selectedConfigValues, setSelectedConfigValues] = useState<
        Record<string, string>
      >({});
      const sync = useSessionComposerControlSync({
        sessionId: 'conv-1',
        isChangingAgent: false,
        liveModeId: 'default',
        displaySessionConfigOptions: [modelOption],
        selectedConfigValues,
        setSelectedMode,
        setSelectedConfigValues,
      });
      return { selectedMode, selectedConfigValues, ...sync };
    });

    act(() => {
      result.current.handleSelectMode('bypassPermissions');
    });

    await waitFor(() => {
      expect(result.current.selectedMode).toBeNull();
    });
    expect(toastErrorMock).toHaveBeenCalledWith('DB write failed');

    act(() => {
      result.current.handleSelectConfigOption('model', 'opus');
    });

    await waitFor(() => {
      expect(result.current.selectedConfigValues).toEqual({});
    });
    expect(toastErrorMock).toHaveBeenCalledWith('Invalid model option');
  });

  it('drops pending selection and shows toast.warning on config_option_rejected event', async () => {
    let listener: ((envelope: AgentEventEnvelope) => void) | undefined;
    listenToAgentEventsMock.mockImplementationOnce(
      async (cb: (envelope: AgentEventEnvelope) => void) => {
        listener = cb;
        return () => {};
      }
    );

    const { result } = renderHook(() => {
      const [selectedMode, setSelectedMode] = useState<string | null>(
        'agent-full-access'
      );
      const [selectedConfigValues, setSelectedConfigValues] = useState<
        Record<string, string>
      >({ mode: 'agent-full-access' });
      useSessionComposerControlSync({
        sessionId: 'conv-2',
        isChangingAgent: false,
        liveModeId: 'agent',
        displaySessionConfigOptions: [],
        selectedConfigValues,
        setSelectedMode,
        setSelectedConfigValues,
      });
      return { selectedMode, selectedConfigValues };
    });

    await waitFor(() => {
      expect(listener).toBeDefined();
    });

    act(() => {
      listener?.({
        sequence: 1n,
        workspace_id: 'ws-1',
        connection_id: 'conn-1',
        session_id: 'conv-2',
        created_at: '2026-11-22T00:00:00Z',
        event: {
          kind: 'config_option_rejected',
          config_id: 'mode',
          option_name: 'Mode',
          requested: 'Agent (full access)',
          actual: 'Approve for me',
          requested_value: 'agent-full-access',
          actual_value: 'agent',
        },
      });
    });

    expect(result.current.selectedMode).toBeNull();
    expect(result.current.selectedConfigValues).toEqual({});
    expect(toastWarningMock).toHaveBeenCalledWith(
      'Mode: Agent (full access) → Approve for me'
    );
  });
});
